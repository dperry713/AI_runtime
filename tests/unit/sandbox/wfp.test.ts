/**
 * Unit tests for WfpClient (Phase W1 - WFP egress enforcement).
 *
 * Tests the TypeScript WFP client using a mock handler (following the
 * SandboxHelperClient mockHandler pattern), avoiding the need to mock
 * node:child_process spawn.
 */

import { describe, expect, it } from 'vitest';
import { AirError } from '../../../src/errors/index.js';
import {
  WfpClient,
  type WfpFilterSpec,
  type WfpRequest,
  type WfpResponse,
  createDefaultDenyFilter,
  createAllowFilter,
} from '../../../src/sandbox/wfp.js';

function makeMockHandler(responses: WfpResponse[]) {
  let index = 0;
  return (_request: WfpRequest): Promise<WfpResponse> => {
    void _request;
    const response = responses[index] as WfpResponse;
    index += 1;
    return Promise.resolve(response);
  };
}

describe('WfpClient', () => {
  it('addFilter sends add_filter request and returns filter result', async () => {
    const spec: WfpFilterSpec = {
      name: 'test-filter',
      ipProtocol: 6,
      remoteAddress: '10.0.0.0/8',
      remotePort: '443',
      action: 'block',
    };

    const client = new WfpClient({
      mockHandler: makeMockHandler([
        {
          type: 'wfp_filter_added',
          version: 1,
          filterId: 42,
          name: 'test-filter',
        },
      ]),
    });

    const result = await client.addFilter(spec);

    expect(result).toEqual({
      filterId: 42,
      name: 'test-filter',
      success: true,
      message: 'WFP filter added successfully',
    });
  });

  it('addFilter throws AirError on error response', async () => {
    const spec: WfpFilterSpec = {
      name: 'bad-filter',
      action: 'block',
    };

    const client = new WfpClient({
      mockHandler: makeMockHandler([
        {
          type: 'error',
          version: 1,
          code: 'WFP_ADD_FAILED',
          message: 'netsh failed: Access is denied.',
        },
        {
          type: 'error',
          version: 1,
          code: 'WFP_ADD_FAILED',
          message: 'netsh failed: Access is denied.',
        },
      ]),
    });

    await expect(client.addFilter(spec)).rejects.toThrow(AirError);
    await expect(client.addFilter(spec)).rejects.toThrow(/WFP add filter failed/);
  });

  it('removeFilter sends remove_filter request and returns success', async () => {
    const client = new WfpClient({
      mockHandler: makeMockHandler([
        {
          type: 'wfp_filter_removed',
          version: 1,
          filterId: 42,
          success: true,
        },
      ]),
    });

    const result = await client.removeFilter(42);

    expect(result).toBe(true);
  });

  it('removeFilter throws AirError on error response', async () => {
    const client = new WfpClient({
      mockHandler: makeMockHandler([
        {
          type: 'error',
          version: 1,
          code: 'WFP_REMOVE_FAILED',
          message: 'Filter not found',
        },
      ]),
    });

    await expect(client.removeFilter(999)).rejects.toThrow(AirError);
  });

  it('listFilters returns list of filters', async () => {
    const client = new WfpClient({
      mockHandler: makeMockHandler([
        {
          type: 'wfp_filters_listed',
          version: 1,
          filters: [
            { filterId: 1, name: 'filter-1', success: true, message: 'active' },
            { filterId: 2, name: 'filter-2', success: true, message: 'active' },
          ],
        },
      ]),
    });

    const filters = await client.listFilters();

    expect(filters).toHaveLength(2);
    expect(filters[0]).toEqual({
      filterId: 1,
      name: 'filter-1',
      success: true,
      message: 'active',
    });
    expect(filters[1]).toEqual({
      filterId: 2,
      name: 'filter-2',
      success: true,
      message: 'active',
    });
  });

  it('addFilter throws on unexpected response type', async () => {
    const client = new WfpClient({
      mockHandler: makeMockHandler([
        { type: 'wfp_filter_removed', version: 1, filterId: 1, success: true } as unknown as WfpResponse,
      ]),
    });
    await expect(client.addFilter({ name: 'f', action: 'block' })).rejects.toThrow(AirError);
  });

  it('removeFilter throws on unexpected response type', async () => {
    const client = new WfpClient({
      mockHandler: makeMockHandler([
        { type: 'wfp_filter_added', version: 1, filterId: 1, name: 'f' } as unknown as WfpResponse,
      ]),
    });
    await expect(client.removeFilter(1)).rejects.toThrow(AirError);
  });

  it('listFilters throws on unexpected response type and error', async () => {
    const client1 = new WfpClient({
      mockHandler: makeMockHandler([
        { type: 'error', version: 1, code: 'ERR', message: 'Fail' },
      ]),
    });
    await expect(client1.listFilters()).rejects.toThrow(AirError);

    const client2 = new WfpClient({
      mockHandler: makeMockHandler([
        { type: 'wfp_filter_added', version: 1, filterId: 1, name: 'f' } as unknown as WfpResponse,
      ]),
    });
    await expect(client2.listFilters()).rejects.toThrow(AirError);
  });

  it('createDefaultDenyFilter produces correct spec', () => {
    const deny = createDefaultDenyFilter('powershell.exe');
    expect(deny.name).toBe('AIR WFP Default Deny powershell.exe');
    expect(deny.action).toBe('block');
    expect(deny.ipProtocol).toBe(255);
    expect(deny.remoteAddress).toBe('0.0.0.0/0');
  });

  it('createAllowFilter produces correct spec', () => {
    const allow = createAllowFilter('GitHub', '10.0.0.0/8', '443', 6);
    expect(allow.name).toBe('AIR WFP Allow GitHub');
    expect(allow.action).toBe('permit');
    expect(allow.ipProtocol).toBe(6);
    expect(allow.remoteAddress).toBe('10.0.0.0/8');
    expect(allow.remotePort).toBe('443');
  });
});
