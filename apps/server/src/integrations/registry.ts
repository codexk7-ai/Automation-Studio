import type { CredentialTypeDefinition, IntegrationDefinition, NodeTypeDefinition } from "@automation-studio/core";
import type { CredentialTypeImplementation, IntegrationModule, NodeImplementation } from "./types.ts";

export class IntegrationRegistry {
  private readonly nodes = new Map<string, NodeImplementation>();
  private readonly integrations = new Map<string, IntegrationDefinition>();
  private readonly credentialTypes = new Map<string, CredentialTypeImplementation>();

  register(mod: IntegrationModule): void {
    if (this.integrations.has(mod.definition.id)) throw new Error(`Integration ${mod.definition.id} registered twice`);
    this.integrations.set(mod.definition.id, mod.definition);
    for (const node of mod.nodes) {
      if (this.nodes.has(node.type)) throw new Error(`Node type ${node.type} registered twice`);
      if (node.integration !== mod.definition.id) throw new Error(`Node ${node.type} declares integration ${node.integration}, expected ${mod.definition.id}`);
      this.nodes.set(node.type, node);
    }
    for (const ct of mod.credentialTypes ?? []) {
      if (this.credentialTypes.has(ct.id)) throw new Error(`Credential type ${ct.id} registered twice`);
      this.credentialTypes.set(ct.id, ct);
    }
  }

  getNode(type: string): NodeImplementation | undefined {
    return this.nodes.get(type);
  }

  getCredentialType(id: string): CredentialTypeImplementation | undefined {
    return this.credentialTypes.get(id);
  }

  /** Serializable node metadata (no handlers) for the editor and MCP. */
  nodeDefinitions(): NodeTypeDefinition[] {
    return [...this.nodes.values()].map(toDefinition);
  }

  nodeDefinition(type: string): NodeTypeDefinition | undefined {
    const n = this.nodes.get(type);
    return n ? toDefinition(n) : undefined;
  }

  integrationDefinitions(): IntegrationDefinition[] {
    return [...this.integrations.values()];
  }

  credentialTypeDefinitions(): CredentialTypeDefinition[] {
    return [...this.credentialTypes.values()].map(({ id, name, description, fields, oauth2, docsUrl }) => ({ id, name, description, fields, oauth2, docsUrl }));
  }
}

function toDefinition(n: NodeImplementation): NodeTypeDefinition {
  const { execute: _e, resume: _r, mock: _m, rawFields: _rf, defaultTimeoutMs: _t, ...def } = n;
  return def;
}
