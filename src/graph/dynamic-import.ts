const SIGNATURE_PREFIX = 'codegraph:dynamic-namespace-import:';

export interface DynamicNamespaceImportMapping {
  localName: string;
  exportedName: '*';
  source: string;
  isDefault: false;
  isNamespace: true;
}

export function dynamicNamespaceImportSignature(localName: string, source: string): string {
  return `${SIGNATURE_PREFIX}${JSON.stringify({ localName, source })}`;
}

export function dynamicNamespaceImportMapping(signature: string | undefined): DynamicNamespaceImportMapping | null {
  if (!signature?.startsWith(SIGNATURE_PREFIX)) return null;
  try {
    const value = JSON.parse(signature.slice(SIGNATURE_PREFIX.length)) as Record<string, unknown>;
    if (typeof value.localName !== 'string' || typeof value.source !== 'string') return null;
    if (!/^[A-Za-z_$][\w$]*$/.test(value.localName) || value.source.length === 0) return null;
    return {
      localName: value.localName,
      exportedName: '*',
      source: value.source,
      isDefault: false,
      isNamespace: true,
    };
  } catch {
    return null;
  }
}
