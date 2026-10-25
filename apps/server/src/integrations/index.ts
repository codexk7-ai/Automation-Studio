import { aiIntegration } from "./ai.ts";
import { hubspotIntegration, postgresIntegration, slackIntegration } from "./business.ts";
import { coreIntegration } from "./core.ts";
import { csvIntegration, tablesIntegration } from "./data.ts";
import { emailIntegration } from "./email.ts";
import { googleIntegration } from "./google.ts";
import { httpIntegration } from "./http.ts";
import { mcpIntegration } from "./mcp.ts";
import { IntegrationRegistry } from "./registry.ts";
import { whatsappIntegration } from "./whatsapp.ts";

export function createRegistry(): IntegrationRegistry {
  const registry = new IntegrationRegistry();
  for (const mod of [
    coreIntegration,
    httpIntegration,
    tablesIntegration,
    csvIntegration,
    emailIntegration,
    aiIntegration,
    mcpIntegration,
    googleIntegration,
    hubspotIntegration,
    whatsappIntegration,
    slackIntegration,
    postgresIntegration,
  ]) {
    registry.register(mod);
  }
  return registry;
}
