import {GrafanaStats} from "./helpers/GrafanaStats";
import {initPrototypes} from "./prototypes/initPrototypes";
import {sandBox} from "./sandbox";
import {Profiler} from "./Profiler";
import {TimeoutTracker} from "./TimeoutTracker";
import {Empire} from "./ai/Empire";
import {Viz} from "./helpers/Viz";
import {Patcher} from "./Patcher";
import {Operation, OperationPriorityMap} from "./ai/operations/Operation";
import {OperationFactory} from "./ai/operations/OperationFactory";
import {Tick} from "./Tick";

/* _____ init phase - instantiate operations _____ */
// init game.cache

let empire: Empire;
let operations: OperationPriorityMap;
try {
    Tick.init();
    initPrototypes();

    empire = Empire.init();
    // scan flags for operations and instantiate
    operations = OperationFactory.getOperations();
    Operation.init(operations);

    // report cpu
    console.log(`Global Refresh CPU: ${Game.cpu.getUsed()}`);

} catch (e) { console.log("error during init phase:\n", e.stack); }

// MAIN LOOP
module.exports.loop = function () {

    // _____ refresh phase - update operations with game state _____

    try {
        Tick.refresh();
        // profile memory parsing
        let cpu = Game.cpu.getUsed();
        if (Memory) { }
        let result = Game.cpu.getUsed() - cpu;
        Profiler.resultOnly("mem", result);

        // reinitialize if flagcount is different (new operations might have been placed)
        operations = OperationFactory.refreshOperations(operations);

        // patch memory or game state from earlier versions of bonzAI
        if (Patcher.checkPatch()) { return; }

        // init utilities
        TimeoutTracker.init();
        TimeoutTracker.log("init"); // TODO: change to "refresh" once you get comparison data

        empire.refresh();
    } catch (e) { console.log("error refreshObjects phase:\n", e.stack); }

    Profiler.start("init");
    Operation.refresh(operations);
    Profiler.end("init");

    // _____ roleCall phase - Find creeps belonging to missions and spawn any additional needed _____
    TimeoutTracker.log("roleCall");
    Profiler.start("roleCall");
    Operation.roleCall(operations);
    Profiler.end("roleCall");

    // _____ actions phase - Actions that change the game state are executed in this phase _____
    TimeoutTracker.log("actions");
    Profiler.start("actions");
    Operation.actions(operations);
    Profiler.end("actions");

    // _____ finalize phase - Code that needs to run post-actions phase _____
    TimeoutTracker.log("finalize");
    Profiler.start("finalize");
    Operation.finalize(operations);
    Profiler.end("finalize");

    // _____ invalidate phase - happens once very 100 ticks on average, garbage collection and misc _____

    Operation.invalidateCache(operations);

    // _____ post-operation actions and utilities _____

    try {

        if (Tick.cache.exceptionCount > 0) {
            console.log(`Exceptions this tick: ${Tick.cache.exceptionCount}`);
        }

        if (Tick.cache.bypassCount > 0) {
            console.log(`BYPASS: ${Tick.cache.bypassCount}`);
        }

        Profiler.start("postOperations");
        empire.actions();
        sandBox.run();
        Viz.maintain();
        Profiler.end("postOperations");
        Profiler.finalize();
        GrafanaStats.run(empire);
        TimeoutTracker.finalize();
    } catch (e) { console.log("error during post-operations phase\n", e.stack); }

    // console.log(`end of loop, time: ${Game.time}, cpu ${Game.cpu.getUsed()}`);
};
