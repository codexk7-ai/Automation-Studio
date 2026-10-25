import { createApp } from "../app.ts";
import type { Principal } from "../auth/principal.ts";
import { registerUser } from "../services/accounts.ts";
import { insertRow } from "../services/tables.ts";
import { instantiateTemplate } from "../services/templates.ts";
import { createWorkflow, publishWorkflow, runWorkflow } from "../services/workflows.ts";

/**
 * Local development seed: a demo owner, sample tables/forms/workflows from
 * templates, sample records and one real (simulated) test run so dashboards
 * show genuine data. Idempotent: does nothing if the demo user exists.
 * Credentials are printed for local use only — never run against production.
 */
const DEMO_EMAIL = process.env.SEED_EMAIL ?? "demo@automation.local";
const DEMO_PASSWORD = process.env.SEED_PASSWORD ?? "demo-password-123";

const app = await createApp();
try {
  if (app.ctx.config.env === "production") throw new Error("Refusing to seed demo data in production.");
  const existing = await app.ctx.db.one("SELECT id FROM users WHERE lower(email) = $1", [DEMO_EMAIL]);
  if (existing) {
    console.log(`Seed skipped: ${DEMO_EMAIL} already exists.`);
  } else {
    const { user, workspaceId } = await registerUser(app.ctx, { email: DEMO_EMAIL, name: "Demo Owner", password: DEMO_PASSWORD, workspaceName: "Demo company" });
    const p: Principal = { actorType: "user", userId: user.id, workspaceId, role: "owner" };

    const leads = await instantiateTemplate(app.ctx, p, "webhook-lead-capture");
    await publishWorkflow(app.ctx, p, leads.workflow.id, "Seeded");
    const intake = await instantiateTemplate(app.ctx, p, "lead-intake-qualification");
    await publishWorkflow(app.ctx, p, intake.workflow.id, "Seeded");
    await instantiateTemplate(app.ctx, p, "daily-report");
    await instantiateTemplate(app.ctx, p, "failure-alerts");

    const leadsTable = await app.ctx.db.one<{ id: string }>("SELECT id FROM data_tables WHERE workspace_id = $1 AND name = 'Leads'", [workspaceId]);
    for (const [name, email, company, score] of [
      ["Ada Lovelace", "ada@example.com", "Analytical Engines", "hot"],
      ["Alan Turing", "alan@example.com", "Bletchley Labs", "warm"],
      ["Grace Hopper", "grace@example.com", "COBOL Co", "hot"],
      ["Linus Example", "linus@example.org", "", "cold"],
    ] as const) {
      await insertRow(app.ctx, p, workspaceId, leadsTable!.id, { name, email, company, score, status: "new", source: "seed" });
    }

    const hello = await createWorkflow(app.ctx, p, {
      name: "Hello world (manual)",
      description: "Minimal example: transform input and branch on a condition.",
      definition: {
        schemaVersion: 1,
        nodes: [
          { id: "trigger", type: "trigger.manual", name: "Run manually", config: { samplePayload: { name: "Ada", plan: "pro" } }, position: { x: 300, y: 40 } },
          { id: "greet", type: "transform.set", name: "Build greeting", config: { fields: { message: "Hello {{ trigger.name }}!", plan: "{{ upper(trigger.plan) }}" } }, position: { x: 300, y: 190 } },
          { id: "isPro", type: "logic.condition", name: "Pro plan?", config: { rules: [{ left: "{{ steps.greet.output.plan }}", operator: "equals", right: "PRO" }] }, position: { x: 300, y: 340 } },
          { id: "summary", type: "ai.summarize", name: "Summarize (mock AI)", config: { text: "{{ steps.greet.output.message }} Thanks for upgrading to the pro plan. Your onboarding call is next week.", style: "tldr" }, position: { x: 160, y: 490 } },
        ],
        edges: [
          { id: "e1", source: "trigger", target: "greet" },
          { id: "e2", source: "greet", target: "isPro" },
          { id: "e3", source: "isPro", target: "summary", branch: "true" },
        ],
      },
    });
    await publishWorkflow(app.ctx, p, hello.id, "Seeded");
    await runWorkflow(app.ctx, p, hello.id, { mode: "test" });
    await app.worker.drain();
    console.log("Seeded demo workspace.");
    console.log(`  Sign in: ${DEMO_EMAIL} / ${DEMO_PASSWORD}  (local development only)`);
  }
} finally {
  await app.close();
}
