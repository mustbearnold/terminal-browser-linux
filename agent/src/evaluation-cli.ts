import { fixtureScenarios, runAgentEvaluation } from "./evaluation";
import { createFixtureAgentHarness } from "./evaluation/loopback";

const harness = createFixtureAgentHarness({ clientId: "evaluation" });
const client = harness.client;

void (async () => {
  try {
    await client.hello();
    const pages = await client.call("pages.list", {});
    const page = pages.pages[0];
    if (!page) throw new Error("evaluation target did not expose a page");
    const report = await runAgentEvaluation(client, fixtureScenarios(page.pageId), {
      trace: harness.trace,
      includeTrace: process.argv.includes("--trace"),
    });
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    if (report.failed > 0) process.exitCode = 1;
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    process.exitCode = 1;
  } finally {
    await client.close();
  }
})();
