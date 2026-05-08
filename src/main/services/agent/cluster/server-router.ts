/**
 * Server Router
 *
 * Routes tasks to NPU servers based on selector expressions and load.
 */

import { createLogger } from '../../../utils/logger';
import type { NpuServer, AcquireWorkersRequest } from '../../../../shared/types/cluster';

const log = createLogger('server-router');

function parseSelector(selector: string): (server: NpuServer) => boolean {
  if (selector === 'all' || !selector) {
    return () => true;
  }

  const clauses = selector.split('&').map((c) => c.trim());
  return (server: NpuServer) => {
    return clauses.every((clause) => {
      const eqIdx = clause.indexOf('=');
      const tildeIdx = clause.indexOf('~');
      if (eqIdx === -1 && tildeIdx === -1) return true;

      const sepIdx = tildeIdx !== -1 ? tildeIdx : eqIdx;
      const isContains = tildeIdx !== -1;
      const fieldPath = clause.substring(0, sepIdx).trim();
      const value = clause.substring(sepIdx + 1).trim();

      const fieldValue = getNestedValue(server, fieldPath);
      if (fieldValue === undefined) return false;

      if (isContains) {
        return Array.isArray(fieldValue)
          ? fieldValue.some((v) => String(v).toLowerCase() === value.toLowerCase())
          : String(fieldValue).toLowerCase().includes(value.toLowerCase());
      }
      return String(fieldValue) === value;
    });
  };
}

function getNestedValue(obj: unknown, path: string): unknown {
  const keys = path.split('.');
  let current: unknown = obj;
  for (const key of keys) {
    if (current === null || current === undefined || typeof current !== 'object') {
      return undefined;
    }
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

export class ServerRouter {
  selectWorkers(servers: NpuServer[], request: AcquireWorkersRequest): NpuServer[] {
    const filter = parseSelector(request.selector);
    let candidates = servers
      .filter((s) => s.status === 'online' || s.status === 'busy')
      .filter(filter);

    switch (request.strategy) {
      case 'least-loaded':
        candidates.sort((a, b) => a.load.runningTasks - b.load.runningTasks);
        break;
      case 'capability':
        candidates.sort(
          (a, b) => b.capabilities.computeType.length - a.capabilities.computeType.length,
        );
        break;
      case 'round-robin':
        candidates.sort(() => Math.random() - 0.5);
        break;
    }

    const count = request.count > 0 ? request.count : candidates.length;
    return candidates.slice(0, count);
  }
}

export const serverRouter = new ServerRouter();