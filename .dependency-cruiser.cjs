/**
 * dependency-cruiser rules enforcing docs/ARCHITECTURE.md §3.
 * Layers (higher may import lower or equal; never upward). Only index.ts is importable across modules.
 */
const layers = {
  types: 0, errors: 0, util: 0,
  config: 1, secrets: 1, observability: 1,
  journal: 2,
  policy: 3, sandbox: 3, providers: 3, memory: 3,
  tools: 4, mcp: 4,
  agent: 5,
  kernel: 6,
  ipc: 7,
  service: 8, shell: 8,
};

const modules = Object.keys(layers);
const forbidden = [];

for (const [mod, layer] of Object.entries(layers)) {
  const higher = modules.filter((m) => layers[m] > layer);
  if (higher.length > 0) {
    forbidden.push({
      name: `layer-${mod}-no-upward-imports`,
      comment: `${mod} (layer ${layer}) must not import higher layers`,
      severity: 'error',
      from: mod === 'secrets'
        ? { path: '^src/secrets/', pathNot: '^src/secrets/credential-manager\\.ts
    });
  }
  forbidden.push({
    name: `${mod}-index-only`,
    comment: `Other modules may import ${mod} only through its index.ts`,
    severity: 'error',
    from: { path: '^src/', pathNot: `^src/${mod}/` },
    to: { path: `^src/${mod}/`, pathNot: `^src/${mod}/index\\.ts$` },
  });
}

// CredentialManagerStore is the single deliberate bridge from the secrets layer
// to the sandbox's public Credential Manager client. Keep the exception narrow:
// all other secrets modules remain subject to the normal layer rule, and this
// adapter may not import any other higher-level module.
forbidden.push(
  {
    name: 'credential-manager-adapter-no-other-upward-imports',
    comment: 'The Credential Manager adapter may depend on sandbox only, not other higher layers',
    severity: 'error',
    from: { path: '^src/secrets/credential-manager\\.ts
    name: 'child-process-only-in-sandbox',
    comment: 'Rule R2: only src/sandbox may spawn processes',
    severity: 'error',
    from: { path: '^src/', pathNot: '^src/sandbox/' },
    to: { dependencyTypes: ['core'], path: '^(node:)?child_process$' },
  },
  {
    name: 'fs-only-in-designated-modules',
    comment: 'Rule R2: node:fs only in util, journal, config, observability, memory',
    severity: 'error',
    from: { path: '^src/', pathNot: '^src/(util|journal|config|observability|memory)/' },
    to: { dependencyTypes: ['core'], path: '^(node:)?fs(/promises)?$' },
  },
  {
    name: 'no-circular',
    severity: 'error',
    from: {},
    to: { circular: true },
  },
);

module.exports = {
  forbidden,
  options: {
    doNotFollow: { path: 'node_modules' },
    tsConfig: { fileName: 'tsconfig.json' },
    tsPreCompilationDeps: true,
    enhancedResolveOptions: {
      exportsFields: ['exports'],
      conditionNames: ['import', 'require', 'node', 'default'],
      extensions: ['.ts', '.js'],
    },
  },
};
 }
        : { path: `^src/${mod}/` },
      to: { path: `^src/(${higher.join('|')})/` },
    });
  }
  forbidden.push({
    name: `${mod}-index-only`,
    comment: `Other modules may import ${mod} only through its index.ts`,
    severity: 'error',
    from: { path: '^src/', pathNot: `^src/${mod}/` },
    to: { path: `^src/${mod}/`, pathNot: `^src/${mod}/index\\.ts$` },
  });
}

forbidden.push(
  {
    name: 'child-process-only-in-sandbox',
    comment: 'Rule R2: only src/sandbox may spawn processes',
    severity: 'error',
    from: { path: '^src/', pathNot: '^src/sandbox/' },
    to: { dependencyTypes: ['core'], path: '^(node:)?child_process$' },
  },
  {
    name: 'fs-only-in-designated-modules',
    comment: 'Rule R2: node:fs only in util, journal, config, observability, memory',
    severity: 'error',
    from: { path: '^src/', pathNot: '^src/(util|journal|config|observability|memory)/' },
    to: { dependencyTypes: ['core'], path: '^(node:)?fs(/promises)?$' },
  },
  {
    name: 'no-circular',
    severity: 'error',
    from: {},
    to: { circular: true },
  },
);

module.exports = {
  forbidden,
  options: {
    doNotFollow: { path: 'node_modules' },
    tsConfig: { fileName: 'tsconfig.json' },
    tsPreCompilationDeps: true,
    enhancedResolveOptions: {
      exportsFields: ['exports'],
      conditionNames: ['import', 'require', 'node', 'default'],
      extensions: ['.ts', '.js'],
    },
  },
};
 },
    to: { path: '^src/(journal|policy|providers|memory|tools|mcp|agent|kernel|ipc|service|shell)/' },
  },
  {
    name: 'child-process-only-in-sandbox',
    comment: 'Rule R2: only src/sandbox may spawn processes',
    severity: 'error',
    from: { path: '^src/', pathNot: '^src/sandbox/' },
    to: { dependencyTypes: ['core'], path: '^(node:)?child_process$' },
  },
  {
    name: 'fs-only-in-designated-modules',
    comment: 'Rule R2: node:fs only in util, journal, config, observability, memory',
    severity: 'error',
    from: { path: '^src/', pathNot: '^src/(util|journal|config|observability|memory)/' },
    to: { dependencyTypes: ['core'], path: '^(node:)?fs(/promises)?$' },
  },
  {
    name: 'no-circular',
    severity: 'error',
    from: {},
    to: { circular: true },
  },
);

module.exports = {
  forbidden,
  options: {
    doNotFollow: { path: 'node_modules' },
    tsConfig: { fileName: 'tsconfig.json' },
    tsPreCompilationDeps: true,
    enhancedResolveOptions: {
      exportsFields: ['exports'],
      conditionNames: ['import', 'require', 'node', 'default'],
      extensions: ['.ts', '.js'],
    },
  },
};
 }
        : { path: `^src/${mod}/` },
      to: { path: `^src/(${higher.join('|')})/` },
    });
  }
  forbidden.push({
    name: `${mod}-index-only`,
    comment: `Other modules may import ${mod} only through its index.ts`,
    severity: 'error',
    from: { path: '^src/', pathNot: `^src/${mod}/` },
    to: { path: `^src/${mod}/`, pathNot: `^src/${mod}/index\\.ts$` },
  });
}

forbidden.push(
  {
    name: 'child-process-only-in-sandbox',
    comment: 'Rule R2: only src/sandbox may spawn processes',
    severity: 'error',
    from: { path: '^src/', pathNot: '^src/sandbox/' },
    to: { dependencyTypes: ['core'], path: '^(node:)?child_process$' },
  },
  {
    name: 'fs-only-in-designated-modules',
    comment: 'Rule R2: node:fs only in util, journal, config, observability, memory',
    severity: 'error',
    from: { path: '^src/', pathNot: '^src/(util|journal|config|observability|memory)/' },
    to: { dependencyTypes: ['core'], path: '^(node:)?fs(/promises)?$' },
  },
  {
    name: 'no-circular',
    severity: 'error',
    from: {},
    to: { circular: true },
  },
);

module.exports = {
  forbidden,
  options: {
    doNotFollow: { path: 'node_modules' },
    tsConfig: { fileName: 'tsconfig.json' },
    tsPreCompilationDeps: true,
    enhancedResolveOptions: {
      exportsFields: ['exports'],
      conditionNames: ['import', 'require', 'node', 'default'],
      extensions: ['.ts', '.js'],
    },
  },
};
