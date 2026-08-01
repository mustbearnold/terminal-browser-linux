import { fixtureScenarios, runAgentEvaluation } from "./evaluation";
import { createFixtureAgentClient } from "./evaluation/loopback";

const client = createFixtureAgentClient({ clientId: "evaluation" });

void (async () => {
  try {
    await client.hello();
    const pages = await client.call("pages.list", {});
    const page = pages.pages[0];
    if (!page) throw new Error("evaluation target did not expose a page");
    const report = await runAgentEvaluation(client, fixtureScenarios(page.pageId));
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    if (report.failed > 0) process.exitCode = 1;
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    process.exitCode = 1;
  } finally {
    await client.close();
  }
})();
