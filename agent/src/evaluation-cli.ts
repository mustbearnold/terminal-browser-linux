import { writeFile } from "node:fs/promises";

import { createAgentEvaluationProvenance, fixtureScenarios, runAgentEvaluation, serializeAgentEvaluationReport } from "./evaluation";
import { createFixtureAgentHarness } from "./evaluation/loopback";

const harness = createFixtureAgentHarness({ clientId: "evaluation" });
const client = harness.client;
const outputPath = optionValue("--output");

void (async () => {
  try {
    await client.hello();
    const pages = await client.call("pages.list", {});
    const page = pages.pages[0];
    if (!page) throw new Error("evaluation target did not expose a page");
    const report = await runAgentEvaluation(client, fixtureScenarios(page.pageId), {
      trace: harness.trace,
      includeTrace: process.argv.includes("--trace"),
      provenance: createAgentEvaluationProvenance(),
    });
    const serialized = serializeAgentEvaluationReport(report);
    if (outputPath) await writeFile(outputPath, serialized, "utf8");
    process.stdout.write(serialized);
    if (report.failed > 0) process.exitCode = 1;
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    process.exitCode = 1;
  } finally {
    await client.close();
  }
})();

function optionValue(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  if (index < 0) return undefined;
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a path`);
  return value;
}
