import { readFileSync } from 'fs';
import { join } from 'path';

export interface PartyThresholdsConfig {
  confidenceAutoSelect: number;
  confidenceRequireConfirm: number;
  maxCandidates: number;
  tieProximityThreshold: number;
}

let cachedConfig: PartyThresholdsConfig | null = null;

export function getPartyThresholds(): PartyThresholdsConfig {
  if (!cachedConfig) {
    const configPath = join(process.cwd(), '..', 'shared', 'partyThresholds.json');

    try {
      const raw = readFileSync(configPath, 'utf-8');
      cachedConfig = JSON.parse(raw) as PartyThresholdsConfig;
    } catch (error) {
      throw new Error(`Failed to load party threshold config at ${configPath}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  return cachedConfig;
}
