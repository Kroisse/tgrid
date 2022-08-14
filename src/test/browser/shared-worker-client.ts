import { SharedWorkerConnector } from "../../protocols/workers/module";
import { ICalculator } from "../controllers/ICalculator";
import { complete } from "./internal";

window.onload = async () => {
    const worker: SharedWorkerConnector<null, null> = new SharedWorkerConnector(
        null,
        null,
    );

    // TEST RE-USABILITY
    for (let i: number = 0; i < 5; ++i) {
        await worker.connect("shared-worker-server.js");

        await ICalculator.main(worker.getDriver<ICalculator>());
        await worker.close();
    }
    complete();
};
