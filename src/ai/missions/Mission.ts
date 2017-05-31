import {Operation} from "../operations/Operation";
import {SpawnGroup} from "../SpawnGroup";
import {HeadCountOptions, TransportAnalysis} from "../../interfaces";
import {Agent} from "./Agent";
export abstract class Mission {

    flag: Flag;
    memory: any;
    spawnGroup: SpawnGroup;
    sources: Source[];
    room: Room;
    name: string;
    operation: Operation;
    allowSpawn: boolean;
    hasVision: boolean;
    waypoints: Flag[];
    partnerPairing: {[role: string]: Agent[]} = {};
    distanceToSpawn: number;

    constructor(operation: Operation, name: string, allowSpawn: boolean = true) {
        this.name = name;
        this.flag = operation.flag;
        this.room = operation.room;
        this.spawnGroup = operation.spawnGroup;
        this.sources = operation.sources;
        if (!operation.memory[name]) operation.memory[name] = {};
        this.memory = operation.memory[name];
        this.allowSpawn = allowSpawn;
        this.operation = operation;
        if (this.room) this.hasVision = true;
        // initialize memory to be used by this mission
        if (!this.memory.hc) this.memory.hc = {};
        if (operation.waypoints && operation.waypoints.length > 0) {
            this.waypoints = operation.waypoints;
        }
    }

    /**
     * Init Phase - Used to initialize values for the following phases
     */
    public abstract initMission();

    /**
     * RoleCall Phase - Used to find creeps and spawn any extra that are needed
     */
    public abstract roleCall();

    /**
     * MissionAction Phase - Primary phase for world-changing functions like creep.harvest(), tower.attack(), etc.
     */
    public abstract missionActions();

    /**
     * Finish Phase - Do any remaining work that needs to happen after the other phases
     */
    public abstract finalizeMission();

    /**
     * Invalidate Cache Phase - Do any housekeeping that might need to be done
     */
    public abstract invalidateMissionCache();

    public setBoost(activateBoost: boolean) {
        let oldValue = this.memory.activateBoost;
        this.memory.activateBoost = activateBoost;
        return `changing boost activation for ${this.name} in ${this.operation.name} from ${oldValue} to ${activateBoost}`;
    }

    public setMax(max: number) {
        let oldValue = this.memory.max;
        this.memory.max = max;
        return `changing max creeps for ${this.name} in ${this.operation.name} from ${oldValue} to ${max}`;
    }

    public setSpawnGroup(spawnGroup: SpawnGroup) {
        this.spawnGroup = spawnGroup;
    }

    public invalidateSpawnDistance() {
        if (this.memory.distanceToSpawn) {
            console.log(`SPAWN: resetting distance for ${this.name} in ${this.operation.name}`);
            this.memory.distanceToSpawn = undefined;
        }
    }

    /**
     * General purpose function for spawning creeps
     * @param roleName - Used to find creeps belonging to this role, examples: miner, energyCart
     * @param getBody - function that returns the body to be used if a new creep needs to be spawned
     * @param getMax - function that returns how many creeps are currently desired, pass 0 to halt spawning
     * @param options - Optional parameters like prespawn interval, whether to disable attack notifications, etc.
     * @returns {Agent[]}
     */

    protected headCount(roleName: string, getBody: () => string[], getMax: () => number,
                        options: HeadCountOptions = {}): Agent[] {
        let agentArray = [];
        if (!this.memory.hc[roleName]) this.memory.hc[roleName] = this.findOrphans(roleName);
        let creepNames = this.memory.hc[roleName] as string[];

        let count = 0;
        for (let i = 0; i < creepNames.length; i++) {
            let creepName = creepNames[i];
            let creep = Game.creeps[creepName];
            if (creep) {
                let agent = new Agent(creep, this);
                let prepared = this.prepAgent(agent, options);
                if (prepared) agentArray.push(agent);
                let ticksNeeded = 0;
                if (options.prespawn !== undefined) {
                    ticksNeeded += creep.body.length * 3;
                    ticksNeeded += options.prespawn;
                }
                if (!creep.ticksToLive || creep.ticksToLive > ticksNeeded) { count++; }
            }
            else {
                creepNames.splice(i, 1);
                delete Memory.creeps[creepName];
                i--;
            }
        }

        let spawnGroup = this.spawnGroup;
        if (options.altSpawnGroup) {
            spawnGroup = options.altSpawnGroup;
        }

        let allowSpawn = spawnGroup.isAvailable && this.allowSpawn && (this.hasVision || options.blindSpawn);
        if (allowSpawn && count < getMax()) {
            let creepName = `${this.operation.name}_${roleName}_${Math.floor(Math.random() * 100)}`;
            let outcome = spawnGroup.spawn(getBody(), creepName, options.memory, options.reservation);
            if (_.isString(outcome)) { creepNames.push(creepName); }
        }

        return agentArray;
    }

    protected spawnSharedAgent(roleName: string, getBody: () => string[]): Agent {
        let spawnMemory = this.spawnGroup.spawns[0].memory;
        if (!spawnMemory.communityRoles) spawnMemory.communityRoles = {};

        let employerName = this.operation.name + this.name;
        let creep: Creep;
        if (spawnMemory.communityRoles[roleName]) {
            let creepName = spawnMemory.communityRoles[roleName];
            creep = Game.creeps[creepName];
            if (creep && Game.map.getRoomLinearDistance(this.spawnGroup.room.name, creep.room.name) <= 3) {
                if (creep.memory.employer === employerName || (!creep.memory.lastTickEmployed || Game.time - creep.memory.lastTickEmployed > 1)) {
                    creep.memory.employer = employerName;
                    creep.memory.lastTickEmployed = Game.time;
                    return new Agent(creep, this);
                }
            }
            else {
                delete Memory.creeps[creepName];
                delete spawnMemory.communityRoles[roleName];
            }
        }

        if (!creep && this.spawnGroup.isAvailable) {
            let creepName = "community_" + roleName;
            while (Game.creeps[creepName]) {
                creepName = "community_" + roleName + "_" + Math.floor(Math.random() * 100);
            }
            let outcome = this.spawnGroup.spawn(getBody(), creepName, undefined, undefined);
            if (_.isString(outcome)) {
                spawnMemory.communityRoles[roleName] = outcome;
            }
            else if (Game.time % 10 !== 0 && outcome !== ERR_NOT_ENOUGH_RESOURCES) {
                console.log(`error spawning community ${roleName} in ${this.operation.name} outcome: ${outcome}`);
            }
        }
    }

    /**
     * Returns creep body array with desired number of parts in this order: WORK → CARRY → MOVE
     * @param workCount
     * @param carryCount
     * @param movecount
     * @returns {string[]}
     */
    protected workerBody(workCount: number, carryCount: number, movecount: number): string[] {
        let body: string [] = [];
        for (let i = 0; i < workCount; i++) {
            body.push(WORK);
        }
        for (let i = 0; i < carryCount; i++) {
            body.push(CARRY);
        }
        for (let i = 0; i < movecount; i++) {
            body.push(MOVE);
        }
        return body;
    }

    protected configBody(config: {[partType: string]: number}): string[] {
        let body: string[] = [];
        for (let partType in config) {
            let amount = config[partType];
            for (let i = 0; i < amount; i++) {
                body.push(partType);
            }
        }
        return body;
    }

    /**
     * Returns creep body array with the desired ratio of parts, governed by how much spawn energy is possible
     * @param workRatio
     * @param carryRatio
     * @param moveRatio
     * @param spawnFraction - proportion of spawn energy to be used up to 50 body parts, .5 would use half, 1 would use all
     * @param limit - set a limit to the number of units (useful if you know the exact limit, like with miners)
     * @returns {string[]}
     */
    protected bodyRatio(workRatio: number, carryRatio: number, moveRatio: number, spawnFraction: number, limit?: number): string[] {
        let sum = workRatio * 100 + carryRatio * 50 + moveRatio * 50;
        let partsPerUnit = workRatio + carryRatio + moveRatio;
        if (!limit) limit = Math.floor(50 / partsPerUnit);
        let maxUnits = Math.min(Math.floor((this.spawnGroup.maxSpawnEnergy * spawnFraction) / sum), limit);
        return this.workerBody(workRatio * maxUnits, carryRatio * maxUnits, moveRatio * maxUnits);
    }

    /**
     * General purpose checking for creep load
     * @param creep
     * @returns {boolean}
     */
    protected hasLoad(creep: Creep): boolean {
        if (creep.memory.hasLoad && _.sum(creep.carry) === 0) {
            creep.memory.hasLoad = false;
        }
        else if (!creep.memory.hasLoad && _.sum(creep.carry) === creep.carryCapacity) {
            creep.memory.hasLoad = true;
        }
        return creep.memory.hasLoad;
    }

    // deprecated
    /**
     * Used to determine cart count/size based on transport distance and the bandwidth needed
     * @param distance - distance (or average distance) from point A to point B
     * @param load - how many resource units need to be transported per tick (example: 10 for an energy source)
     * @returns {{body: string[], cartsNeeded: number}}
     */
    protected cacheTransportAnalysis(distance: number, load: number): TransportAnalysis {
        if (!this.memory.transportAnalysis || load !== this.memory.transportAnalysis.load
            || distance !== this.memory.transportAnalysis.distance) {
            this.memory.transportAnalysis = Mission.analyzeTransport(distance, load, this.spawnGroup.maxSpawnEnergy)
        }
        return this.memory.transportAnalysis;
    }

    // deprecated
    static analyzeTransport(distance: number, load: number, maxSpawnEnergy: number): TransportAnalysis {
        // cargo units are just 2 CARRY, 1 MOVE, which has a capacity of 100 and costs 150
        let maxUnitsPossible = Math.min(Math.floor(maxSpawnEnergy /
            ((BODYPART_COST[CARRY] * 2) + BODYPART_COST[MOVE])), 16);
        let bandwidthNeeded = distance * load * 2.1;
        let cargoUnitsNeeded = Math.ceil(bandwidthNeeded / (CARRY_CAPACITY * 2));
        let cartsNeeded = Math.ceil(cargoUnitsNeeded / maxUnitsPossible);
        let cargoUnitsPerCart = Math.floor(cargoUnitsNeeded / cartsNeeded);
        return {
            load: load,
            distance: distance,
            cartsNeeded: cartsNeeded,
            carryCount: cargoUnitsPerCart * 2,
            moveCount: cargoUnitsPerCart,
        };
    }

    // deprecated
    static loadFromSource(source: Source): number {
        return Math.max(source.energyCapacity, SOURCE_ENERGY_CAPACITY) / ENERGY_REGEN_TIME;
    }

    protected getFlagSet(identifier: string, max = 10): Flag[] {

        let flags = [];
        for (let i = 0; i < max; i++) {
            let flag = Game.flags[this.operation.name + identifier + i];
            if (flag) {
                flags.push(flag);
            }
        }
        return flags;
    }

    protected flagLook(lookConstant: string, identifier: string, max = 10) {

        let objects = [];

        let flags = this.getFlagSet(identifier, max);
        for (let flag of flags) {
            if (flag.room) {
                let object = _.head(flag.pos.lookFor(lookConstant));
                if (object) {
                    objects.push(object);
                }
                else {
                    flag.remove();
                }
            }
        }

        return objects;
    }

    // deprecated, use similar function on TransportGuru
    getStorage(pos: RoomPosition): StructureStorage {
        return null; //Not implemented.
    }

    private findOrphans(roleName: string) {
        let creepNames = [];
        for (let creepName in Game.creeps) {
            if (creepName.indexOf(this.operation.name + "_" + roleName + "_") > -1) {
                creepNames.push(creepName);
            }
        }
        return creepNames;
    }

    protected recycleAgent(agent: Agent) {
        let spawn = this.spawnGroup.spawns[0];
        if (agent.pos.isNearTo(spawn)) {
            spawn.recycleCreep(agent.creep);
        }
        else {
            agent.travelTo(spawn);
        }
    }

    private prepAgent(agent: Agent, options: HeadCountOptions) {
        if (!agent.memory.prep) {
            if (options.disableNotify) {
                this.disableNotify(agent)
            }
            let boosted = agent.seekBoost(agent.memory.boosts, agent.memory.allowUnboosted);
            if (!boosted) return false;
            if (agent.creep.spawning) return false;
            if (!options.skipMoveToRoom && (agent.pos.roomName !== this.flag.pos.roomName || agent.pos.isNearExit(1))) {
                agent.avoidSK(this.flag);
                return;
            }
            agent.memory.prep = true;
        }
        return true;
    }

    protected findPartnerships(agents: Agent[], role: string) {
        for (let agent of agents) {
            if (!agent.memory.partner) {
                if (!this.partnerPairing[role]) this.partnerPairing[role] = [];
                this.partnerPairing[role].push(agent);
                for (let otherRole in this.partnerPairing) {
                    if (role === otherRole) continue;
                    let otherCreeps = this.partnerPairing[otherRole];
                    let closestCreep;
                    let smallestAgeDifference = Number.MAX_VALUE;
                    for (let otherCreep of otherCreeps) {
                        let ageDifference = Math.abs(agent.ticksToLive - otherCreep.ticksToLive);
                        if (ageDifference < smallestAgeDifference) {
                            smallestAgeDifference = ageDifference;
                            closestCreep = otherCreep;
                        }
                    }

                    if (closestCreep) {
                        closestCreep.memory.partner = agent.name;
                        agent.memory.partner = closestCreep.name;
                    }
                }
            }
        }
    }

    protected getPartner(agent: Agent, possibilities: Agent[]): Agent {
        for (let possibility of possibilities) {
            if (possibility.name === agent.memory.partner) {
                return possibility;
            }
        }
    }

    protected findDistanceToSpawn(destination: RoomPosition): number {
        throw new Error("Not yet implemented");
    }

    protected disableNotify(creep: Creep | Agent) {
        if (creep instanceof Agent) {
            creep = creep.creep;
        }

        if (!creep.memory.notifyDisabled) {
            creep.notifyWhenAttacked(false);
            creep.memory.notifyDisabled = true;
        }
    }

    protected pavePath(start: {pos: RoomPosition}, finish: {pos: RoomPosition}, rangeAllowance: number, ignoreLimit = false): number {
        if (Game.time - this.memory.paveTick < 1000) return;

        if (Game.map.getRoomLinearDistance(start.pos.roomName, finish.pos.roomName) > 2) {
            console.log(`PAVER: path too long: ${start.pos.roomName} to ${finish.pos.roomName}`);
            return;
        }
        let path = this.findPavedPath(start.pos, finish.pos, rangeAllowance);

        if (!path) {
            console.log(`incomplete pavePath, please investigate (${this.operation.name}), start: ${start.pos}, finish: ${finish.pos}, mission: ${this.name}`);
            return;
        }

        let newConstructionPos = this.examinePavedPath(path);

        if (newConstructionPos && (ignoreLimit || Object.keys(Game.constructionSites).length < 60)) {
            if (!Game.cache.placedRoad) {
                Game.cache.placedRoad = true;
                console.log(`PAVER: placed road ${newConstructionPos} in ${this.operation.name}`);
                newConstructionPos.createConstructionSite(STRUCTURE_ROAD);
            }
        }
        else {
            this.memory.paveTick = Game.time;
            if (_.last(path).inRangeTo(finish.pos, rangeAllowance)) {
                return path.length;
            }
        }
    }

    // This path making will only be valid for an origin/destination with a roomdistance less than 3
    protected findPavedPath(start: RoomPosition, finish: RoomPosition, rangeAllowance: number): RoomPosition[] {
        const ROAD_COST = 3;
        const PLAIN_COST = 4;
        const SWAMP_COST = 5;
        const AVOID_COST = 7;

        let maxDistance = Game.map.getRoomLinearDistance(start.roomName, finish.roomName);
        throw new Error("Not yet implemented.");
    }

    private examinePavedPath(path: RoomPosition[]) {

        let repairIds = [];
        let hitsToRepair = 0;

        for (let i = 0; i < path.length; i++) {
            let position = path[i];
            if (!Game.rooms[position.roomName]) return;
            if (position.isNearExit(0)) continue;
            let road = position.lookForStructure(STRUCTURE_ROAD);
            if (road) {
                repairIds.push(road.id);
                hitsToRepair += road.hitsMax - road.hits;
                // TODO: calculate how much "a whole lot" should be based on paver repair rate
                const A_WHOLE_LOT = 1000000;
                if (!this.memory.roadRepairIds && (hitsToRepair > A_WHOLE_LOT || road.hits < road.hitsMax * .20)) {
                    console.log(`PAVER: I'm being summoned in ${this.operation.name}`);
                    this.memory.roadRepairIds = repairIds;
                }
                continue;
            }
            let construction = position.lookFor<ConstructionSite>(LOOK_CONSTRUCTION_SITES)[0];
            if (construction) continue;
            return position;
        }
    }

    protected paverActions(paver: Agent) {

        // paver, healthyself
        if (paver.hits < paver.hitsMax) {
            if (paver.room.hostiles.length === 0 && !paver.pos.isNearExit(0)) {
                let tower = paver.pos.findClosestByRange(paver.room.findStructures<StructureTower>(STRUCTURE_TOWER));
                if (tower) {
                    tower.heal(paver.creep);
                    return;
                }
            }
            let healersInRoom = _.filter(paver.room.find<Creep>(FIND_MY_CREEPS), c => c.getActiveBodyparts(HEAL));
            if (healersInRoom.length > 0) {
                paver.idleOffRoad();
                return;
            }
            if (paver.getActiveBodyparts(WORK) === 0) {
                paver.travelTo(this.spawnGroup);
                return;
            }
        }

        let hasLoad = paver.hasLoad();
        if (!hasLoad) {
            paver.procureEnergy(this.findRoadToRepair());
            return;
        }

        let road = this.findRoadToRepair();

        if (!road) {
            console.log(`this is ${this.operation.name} paver, checking out with ${paver.ticksToLive} ticks to live`);
            delete Memory.creeps[paver.name];
            paver.idleOffRoad(this.room.controller);
            return;
        }

        let paving = false;
        if (paver.pos.inRangeTo(road, 3) && !paver.pos.isNearExit(0)) {
            paving = paver.repair(road) === OK;
            let hitsLeftToRepair = road.hitsMax - road.hits;
            if (hitsLeftToRepair > 10000) {
                paver.yieldRoad(road, true);
            }
            else if (hitsLeftToRepair > 1500) {
                paver.yieldRoad(road, false)
            }
        }
        else {
            paver.travelTo(road, {range: 0});
        }

        if (!paving) {
            road = paver.pos.lookForStructure(STRUCTURE_ROAD) as StructureRoad;
            if (road && road.hits < road.hitsMax) paver.repair(road);
        }

        paver.stealNearby("creep");
    }

    private findRoadToRepair(): StructureRoad {
        if (!this.memory.roadRepairIds) return;

        let road = Game.getObjectById<StructureRoad>(this.memory.roadRepairIds[0]);
        if (road && road.hits < road.hitsMax) {
            return road;
        }
        else {
            this.memory.roadRepairIds.shift();
            if (this.memory.roadRepairIds.length > 0) {
                return this.findRoadToRepair();
            }
            else {
                this.memory.roadRepairIds = undefined;
            }
        }
    }

    protected spawnPaver(): Agent {
        if (this.room.controller && this.room.controller.level === 1) return;
        let paverBody = () => { return this.bodyRatio(1, 3, 2, 1, 5); };
        return this.spawnSharedAgent("paver", paverBody);
    }

    protected registerPrespawn(agent: Agent) {
        if (!agent.memory.registered) {
            agent.memory.registered = true;
            const SANITY_CHECK = CREEP_LIFE_TIME / 2;
            this.memory.prespawn = Math.max(CREEP_LIFE_TIME - agent.creep.ticksToLive, SANITY_CHECK);
        }
    }

    protected medicActions(defender: Agent) {
        let hurtCreep = this.findHurtCreep(defender);
        if (!hurtCreep) {
            defender.idleNear(this.flag, 12);
            return;
        }

        // move to creep
        let range = defender.pos.getRangeTo(hurtCreep);
        if (range > 1) {
            defender.travelTo(hurtCreep, {movingTarget: true});
        }
        else {
            defender.yieldRoad(hurtCreep, true);
        }

        if (range === 1) {
            defender.heal(hurtCreep);
        }
        else if (range <= 3) {
            defender.rangedHeal(hurtCreep);
        }
    }

    private findHurtCreep(defender: Agent) {
        if (!this.room) return;

        if (defender.memory.healId) {
            let creep = Game.getObjectById(defender.memory.healId) as Creep;
            if (creep && creep.room.name === defender.room.name && creep.hits < creep.hitsMax) {
                return creep;
            }
            else {
                defender.memory.healId = undefined;
                return this.findHurtCreep(defender);
            }
        }
        else if (!defender.memory.healCheck || Game.time - defender.memory.healCheck > 25) {
            defender.memory.healCheck = Game.time;
            let hurtCreep = _(this.room.find<Creep>(FIND_MY_CREEPS))
                .filter((c: Creep) => c.hits < c.hitsMax && c.ticksToLive > 100)
                .sortBy((c: Creep) => -c.partCount(WORK))
                .head();

            if (hurtCreep) {
                defender.memory.healId = hurtCreep.id;
                return hurtCreep;
            }
        }
    }
}