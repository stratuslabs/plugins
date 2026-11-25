import type { ServerResponse } from 'node:http';

export interface DashboardAssetOptions {
  /** Override the asset directory. Tests use it; nothing else should. */
  root?: string;
}

/** What `@stratusagent/control-api` calls to serve the web UI at `/`. */
export interface DashboardAssets {
  /** Serve this path, or report that there is no asset for it. */
  serve(pathname: string, response: ServerResponse): Promise<boolean>;
}

/** Static assets for the control API to serve at `/`. */
export declare const createDashboardAssets: (options?: DashboardAssetOptions) => DashboardAssets;
