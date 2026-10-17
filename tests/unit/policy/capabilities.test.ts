import { describe, expect, it } from 'vitest';
import {
  calculateCapabilitySpecificity,
  createCapability,
  createExecCapability,
  createFsCapability,
  createNetCapability,
  formatCapability,
  isCapabilitySubsumed,
  matchCapability,
  matchCommandPattern,
  matchHostPattern,
  matchPathPattern,
  parseCapabilityPattern,
  tokenizeCommandLine,
} from '../../../src/policy/index.js';

describe('Capability Model (P5-T01)', () => {
  describe('Capability Constructors & Schema Validation', () => {
    it('creates and normalizes filesystem capability atoms', () => {
      const cap = createFsCapability('read', 'C:/repo/src/index.ts');
      expect(cap.type).toBe('fs');
      expect(cap.action).toBe('read');
      expect(cap.resource).toBe('C:\\repo\\src\\index.ts');

      expect(() => createFsCapability('write', '')).toThrow();
    });

    it('creates network capability atoms with host, port, and URL metadata', () => {
      const cap = createNetCapability('fetch', 'https://api.github.com/repos', {
        port: 443,
        protocol: 'https:',
      });
      expect(cap.type).toBe('net');
      expect(cap.action).toBe('fetch');
      expect(cap.resource).toBe('https://api.github.com/repos');
      expect(cap.meta?.['port']).toBe(443);

      expect(() => createNetCapability('fetch', '   ')).toThrow();
    });

    it('creates execution capability atoms with command, args, and shell options', () => {
      const cap = createExecCapability('run', 'git', {
        args: ['checkout', 'main'],
        shell: 'powershell.exe',
      });
      expect(cap.type).toBe('exec');
      expect(cap.action).toBe('run');
      expect(cap.resource).toBe('git');
      expect(cap.meta?.['args']).toEqual(['checkout', 'main']);
      expect(cap.meta?.['shell']).toBe('powershell.exe');

      expect(() => createExecCapability('run', '')).toThrow();
    });

    it('creates generic capability atoms', () => {
      const cap = createCapability('user', 'ask', 'confirm_deploy', { timeoutMs: 5000 });
      expect(cap.type).toBe('user');
      expect(cap.action).toBe('ask');
      expect(cap.resource).toBe('confirm_deploy');
      expect(cap.meta?.['timeoutMs']).toBe(5000);

      expect(() => createCapability('')).toThrow();
    });
  });

  describe('Canonical String Parsing & Formatting', () => {
    it('formats capabilities into canonical strings', () => {
      expect(formatCapability({ type: 'fs', action: 'read', resource: 'C:\\data\\*.txt' })).toBe(
        'fs:read:C:\\data\\*.txt',
      );
      expect(formatCapability({ type: 'net', action: 'fetch', resource: 'api.github.com' })).toBe(
        'net:fetch:api.github.com',
      );
      expect(formatCapability({ type: 'exec', action: ['run'], resource: 'npm test' })).toBe(
        'exec:run:npm test',
      );
      expect(formatCapability({ type: 'fs', action: ['read', 'list'], resource: '*' })).toBe(
        'fs:read|list:*',
      );
    });

    it('parses full capability strings with Windows drive letters', () => {
      const parsed = parseCapabilityPattern('fs:read:C:\\repo\\**');
      expect(parsed.type).toBe('fs');
      expect(parsed.action).toBe('read');
      expect(parsed.resource).toBe('C:\\repo\\**');
    });

    it('parses multi-action capability patterns', () => {
      const parsed = parseCapabilityPattern('fs:read|list|stat:C:\\data\\*');
      expect(parsed.type).toBe('fs');
      expect(parsed.action).toEqual(['read', 'list', 'stat']);
      expect(parsed.resource).toBe('C:\\data\\*');
    });

    it('parses shorthand patterns (domain-only or domain:action)', () => {
      const domainOnly = parseCapabilityPattern('fs');
      expect(domainOnly.type).toBe('fs');
      expect(domainOnly.action).toBe('*');
      expect(domainOnly.resource).toBe('*');

      const domainAction = parseCapabilityPattern('exec:run');
      expect(domainAction.type).toBe('exec');
      expect(domainAction.action).toBe('run');
      expect(domainAction.resource).toBe('*');
    });

    it('rejects invalid or empty pattern strings', () => {
      expect(() => parseCapabilityPattern('')).toThrow();
      expect(() => parseCapabilityPattern('   ')).toThrow();
    });
  });

  describe('Windows-Aware Path Pattern Matching', () => {
    it('matches exact files with slash normalization and case-insensitivity', () => {
      expect(matchPathPattern('C:\\repo\\file.txt', 'c:/repo/file.txt')).toBe(true);
      expect(matchPathPattern('c:/repo/src/index.ts', 'C:\\REPO\\SRC\\INDEX.TS')).toBe(true);
      expect(matchPathPattern('C:\\repo\\file.txt', 'C:\\repo\\other.txt')).toBe(false);
    });

    it('supports single segment wildcard (*)', () => {
      expect(matchPathPattern('C:\\repo\\*.txt', 'C:\\repo\\file.txt')).toBe(true);
      expect(matchPathPattern('C:\\repo\\*.txt', 'C:\\repo\\notes.txt')).toBe(true);
      // Single * does NOT cross path separator
      expect(matchPathPattern('C:\\repo\\*.txt', 'C:\\repo\\sub\\file.txt')).toBe(false);
    });

    it('supports recursive wildcard (**) at the end of path', () => {
      const pattern = 'C:\\repo\\**';
      expect(matchPathPattern(pattern, 'C:\\repo')).toBe(true);
      expect(matchPathPattern(pattern, 'C:\\repo\\file.txt')).toBe(true);
      expect(matchPathPattern(pattern, 'C:\\repo\\src\\sub\\deep\\nested.ts')).toBe(true);
      expect(matchPathPattern(pattern, 'C:\\other\\file.txt')).toBe(false);
    });

    it('supports infix recursive wildcard (**)', () => {
      const pattern = 'C:\\repo\\**\\test\\*.test.ts';
      expect(matchPathPattern(pattern, 'C:\\repo\\test\\smoke.test.ts')).toBe(true);
      expect(matchPathPattern(pattern, 'C:\\repo\\sub\\dir\\test\\unit.test.ts')).toBe(true);
      expect(matchPathPattern(pattern, 'C:\\repo\\sub\\dir\\src\\unit.ts')).toBe(false);
    });

    it('collapses relative dots and resists traversal escapes', () => {
      // C:\repo\sub\..\file.txt collapses to C:\repo\file.txt, which is inside C:\repo\**
      expect(matchPathPattern('C:\\repo\\**', 'C:\\repo\\sub\\..\\file.txt')).toBe(true);
      // C:\repo\..\secret.txt collapses to C:\secret.txt, outside C:\repo\**
      expect(matchPathPattern('C:\\repo\\**', 'C:\\repo\\..\\secret.txt')).toBe(false);
    });
  });

  describe('Host & Network Pattern Matching', () => {
    it('matches exact hostnames case-insensitively', () => {
      expect(matchHostPattern('api.github.com', 'API.GITHUB.COM')).toBe(true);
      expect(matchHostPattern('api.github.com', 'api.gitlab.com')).toBe(false);
    });

    it('matches wildcard subdomains (*.example.com)', () => {
      const pattern = '*.example.com';
      expect(matchHostPattern(pattern, 'example.com')).toBe(true);
      expect(matchHostPattern(pattern, 'api.example.com')).toBe(true);
      expect(matchHostPattern(pattern, 'deep.sub.api.example.com')).toBe(true);
      expect(matchHostPattern(pattern, 'notexample.com')).toBe(false);
      expect(matchHostPattern(pattern, 'example.org')).toBe(false);
    });

    it('matches targets provided as full URLs', () => {
      expect(matchHostPattern('api.github.com', 'https://api.github.com/v1/repos')).toBe(true);
      expect(matchHostPattern('*.github.com', 'https://raw.github.com/readme.md')).toBe(true);
    });

    it('enforces port constraints', () => {
      expect(matchHostPattern('api.github.com:443', 'https://api.github.com')).toBe(true);
      expect(matchHostPattern('api.github.com:443', 'http://api.github.com')).toBe(false);
      expect(matchHostPattern('*:8080', 'http://localhost:8080')).toBe(true);
      expect(matchHostPattern('*:8080', 'http://localhost:3000')).toBe(false);
    });

    it('matches IPv4 exact addresses and CIDR subnets', () => {
      expect(matchHostPattern('127.0.0.1', '127.0.0.1')).toBe(true);
      expect(matchHostPattern('127.0.0.1', '127.0.0.2')).toBe(false);

      // CIDR matching
      const cidr = '192.168.0.0/16';
      expect(matchHostPattern(cidr, '192.168.1.1')).toBe(true);
      expect(matchHostPattern(cidr, '192.168.254.254')).toBe(true);
      expect(matchHostPattern(cidr, '192.169.1.1')).toBe(false);

      const privateA = '10.0.0.0/8';
      expect(matchHostPattern(privateA, '10.5.20.100')).toBe(true);
      expect(matchHostPattern(privateA, '11.0.0.1')).toBe(false);
    });

    it('global wildcard matches any host', () => {
      expect(matchHostPattern('*', 'anything.com')).toBe(true);
      expect(matchHostPattern('*', '1.2.3.4')).toBe(true);
    });
  });

  describe('Command Pattern Matching', () => {
    it('tokenizes command line strings with quotes', () => {
      const tokens = tokenizeCommandLine('git commit -m "initial commit" --author=\'Antigravity Agent\'');
      expect(tokens).toEqual(['git', 'commit', '-m', 'initial commit', '--author=Antigravity Agent']);
    });

    it('normalizes Windows executable names (.exe strip and path strip)', () => {
      expect(matchCommandPattern('git', 'git.exe')).toBe(true);
      expect(matchCommandPattern('git', 'GIT.EXE')).toBe(true);
      expect(matchCommandPattern('git', 'C:\\Program Files\\Git\\cmd\\git.exe')).toBe(true);
      expect(matchCommandPattern('git.exe', 'git')).toBe(true);
    });

    it('matches exact commands with arguments', () => {
      expect(matchCommandPattern('npm test', 'npm', ['test'])).toBe(true);
      expect(matchCommandPattern('npm test', 'npm test')).toBe(true);
      expect(matchCommandPattern('npm test', 'npm run test')).toBe(false);
    });

    it('supports argument wildcards (*)', () => {
      expect(matchCommandPattern('git checkout *', 'git checkout main')).toBe(true);
      expect(matchCommandPattern('git checkout *', 'git checkout feat/p5')).toBe(true);
      expect(matchCommandPattern('git checkout *', 'git checkout')).toBe(false);
      expect(matchCommandPattern('git checkout *', 'git checkout main --force')).toBe(false);
    });

    it('supports recursive argument wildcard (**)', () => {
      expect(matchCommandPattern('cargo **', 'cargo build')).toBe(true);
      expect(matchCommandPattern('cargo **', 'cargo test --all --release')).toBe(true);
      expect(matchCommandPattern('cargo **', 'cargo')).toBe(true);
    });

    it('command-only pattern matches any arguments', () => {
      expect(matchCommandPattern('node', 'node app.js')).toBe(true);
      expect(matchCommandPattern('python', 'python -m pytest')).toBe(true);
    });
  });

  describe('Universal Capability Matching', () => {
    it('matches filesystem capabilities against pattern', () => {
      const pattern = 'fs:read:C:\\project\\**';
      const cap = createFsCapability('read', 'C:\\project\\src\\index.ts');
      expect(matchCapability(pattern, cap)).toBe(true);

      const writeCap = createFsCapability('write', 'C:\\project\\src\\index.ts');
      expect(matchCapability(pattern, writeCap)).toBe(false);

      const outsideCap = createFsCapability('read', 'C:\\windows\\system32\\calc.exe');
      expect(matchCapability(pattern, outsideCap)).toBe(false);
    });

    it('matches network capabilities against pattern', () => {
      const pattern = 'net:fetch:*.github.com';
      const cap = createNetCapability('fetch', 'https://api.github.com/events');
      expect(matchCapability(pattern, cap)).toBe(true);

      const wrongAction = createNetCapability('listen', 'https://api.github.com/events');
      expect(matchCapability(pattern, wrongAction)).toBe(false);

      const wrongHost = createNetCapability('fetch', 'https://evil.com/events');
      expect(matchCapability(pattern, wrongHost)).toBe(false);
    });

    it('matches execution capabilities against pattern', () => {
      const pattern = 'exec:run:git status';
      const cap = createExecCapability('run', 'git', { args: ['status'] });
      expect(matchCapability(pattern, cap)).toBe(true);

      const wrongCmd = createExecCapability('run', 'git', { args: ['push'] });
      expect(matchCapability(pattern, wrongCmd)).toBe(false);
    });

    it('matches metadata constraints when defined in pattern', () => {
      const pattern = {
        type: 'user',
        action: 'ask',
        resource: '*',
        meta: { channel: 'cli' },
      };

      const matchingCap = createCapability('user', 'ask', 'q1', { channel: 'cli', priority: 'high' });
      expect(matchCapability(pattern, matchingCap)).toBe(true);

      const nonMatchingCap = createCapability('user', 'ask', 'q1', { channel: 'slack' });
      expect(matchCapability(pattern, nonMatchingCap)).toBe(false);
    });
  });

  describe('Capability Specificity Calculation', () => {
    it('scores exact patterns higher than wildcard patterns monotonically', () => {
      const allWildcard = calculateCapabilitySpecificity('*:*:*');
      const domainOnly = calculateCapabilitySpecificity('fs:*:*');
      const actionSpecified = calculateCapabilitySpecificity('fs:read:*');
      const recursiveGlob = calculateCapabilitySpecificity('fs:read:C:\\repo\\**');
      const singleGlob = calculateCapabilitySpecificity('fs:read:C:\\repo\\*.ts');
      const exactFile = calculateCapabilitySpecificity('fs:read:C:\\repo\\src\\index.ts');

      expect(domainOnly).toBeGreaterThan(allWildcard);
      expect(actionSpecified).toBeGreaterThan(domainOnly);
      expect(recursiveGlob).toBeGreaterThan(actionSpecified);
      expect(singleGlob).toBeGreaterThan(recursiveGlob);
      expect(exactFile).toBeGreaterThan(singleGlob);
    });

    it('scores deeper paths higher due to depth bonus', () => {
      const shallow = calculateCapabilitySpecificity('fs:read:C:\\file.txt');
      const deep = calculateCapabilitySpecificity('fs:read:C:\\dev\\project\\src\\sub\\file.txt');
      expect(deep).toBeGreaterThan(shallow);
    });
  });

  describe('Capability Subsumption Analysis', () => {
    it('confirms parent pattern subsumes child pattern', () => {
      expect(isCapabilitySubsumed('fs:read:C:\\repo\\src\\index.ts', 'fs:read:C:\\repo\\**')).toBe(true);
      expect(isCapabilitySubsumed('fs:read:C:\\repo\\**', 'fs:*:C:\\repo\\**')).toBe(true);
      expect(isCapabilitySubsumed('fs:*:C:\\repo\\**', 'fs:*:*')).toBe(true);
      expect(isCapabilitySubsumed('fs:*:*', '*:*:*')).toBe(true);
    });

    it('returns false when child is broader or disjoint from parent', () => {
      // Child is broader than parent
      expect(isCapabilitySubsumed('fs:read:C:\\repo\\**', 'fs:read:C:\\repo\\src\\index.ts')).toBe(false);
      // Different actions
      expect(isCapabilitySubsumed('fs:write:C:\\repo\\**', 'fs:read:C:\\repo\\**')).toBe(false);
      // Different resources
      expect(isCapabilitySubsumed('fs:read:C:\\other\\**', 'fs:read:C:\\repo\\**')).toBe(false);
    });

    it('subsumes network, exec, and custom capabilities correctly', () => {
      expect(isCapabilitySubsumed('net:fetch:api.github.com', 'net:fetch:*.github.com')).toBe(true);
      expect(isCapabilitySubsumed('net:fetch:*.github.com', 'net:fetch:api.github.com')).toBe(false);
      expect(isCapabilitySubsumed('exec:run:git status', 'exec:run:git *')).toBe(true);
      expect(isCapabilitySubsumed('exec:run:git *', 'exec:run:git status')).toBe(false);
      expect(isCapabilitySubsumed('custom:action:item1', 'custom:action:item1')).toBe(true);
      expect(isCapabilitySubsumed('custom:action:item1', 'custom:action:item2')).toBe(false);
      expect(isCapabilitySubsumed('fs:read:*', 'fs:read:C:\\repo\\**')).toBe(false);
      expect(isCapabilitySubsumed('fs:read:*', 'net:fetch:*')).toBe(false);
      expect(isCapabilitySubsumed('fs:*:*', 'fs:read:*')).toBe(false);
      expect(isCapabilitySubsumed('fs:read|write:C:\\repo\\**', 'fs:read:C:\\repo\\**')).toBe(false);
      expect(isCapabilitySubsumed('fs:read|list:C:\\repo\\**', 'fs:read|list|write:C:\\repo\\**')).toBe(true);
    });
  });

  describe('Edge cases and boundary branches', () => {
    it('handles IPv6 bracketed hosts and port parsing', () => {
      expect(matchHostPattern('[::1]:8080', '[::1]:8080')).toBe(true);
      expect(matchHostPattern('[::1]:8080', '[::1]:9090')).toBe(false);
      expect(matchHostPattern('[::1]', '[::1]')).toBe(true);
    });

    it('handles CIDR edge cases including prefix 0 and invalid CIDR strings', () => {
      expect(matchHostPattern('0.0.0.0/0', '1.2.3.4')).toBe(true);
      expect(matchHostPattern('10.0.0.0/99', '10.0.0.1')).toBe(false);
      expect(matchHostPattern('invalid/cidr', '10.0.0.1')).toBe(false);
      expect(matchHostPattern('10.0.0.0/-1', '10.0.0.1')).toBe(false);
      expect(matchHostPattern('10.0.0.0/16', 'not.an.ip')).toBe(false);
    });

    it('handles generic capabilities in matchCapability', () => {
      const genericPattern = {
        type: 'custom_device',
        action: 'write',
        resource: 'gpio_pin_4',
      };
      const matching = createCapability('custom_device', 'write', 'gpio_pin_4');
      const nonMatching = createCapability('custom_device', 'write', 'gpio_pin_5');
      expect(matchCapability(genericPattern, matching)).toBe(true);
      expect(matchCapability(genericPattern, nonMatching)).toBe(false);
    });

    it('calculates specificity with metadata and action arrays', () => {
      const multiAction = calculateCapabilitySpecificity({
        type: 'fs',
        action: ['read', 'list'],
        resource: 'C:\\data\\*',
      });
      const withMeta = calculateCapabilitySpecificity({
        type: 'fs',
        action: 'read',
        resource: 'C:\\data\\*',
        meta: { env: 'prod', user: 'admin' },
      });
      expect(withMeta).toBeGreaterThan(multiAction);
    });
  });
});
