/**
 * Wraps the native `fetch` with an AbortController-based timeout.
 *
 * The timeout covers the *entire* request lifecycle — both header resolution
 * and body consumption (.json(), .text(), .arrayBuffer()).  The AbortController
 * timer is only cleared after the body method returns (or throws), so a stalled
 * mid-body transfer (e.g. a large DOCX download) is correctly aborted.
 *
 * Default timeout: 30 seconds — covers slow Confluence/Jira/Google instances
 * without blocking the Node process indefinitely on a stalled connection.
 */
export async function fetchWithTimeout(url: string, init: RequestInit = {}, ms = 30_000): Promise<Response> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), ms);

    try {
        const rawResponse = await fetch(url, { ...init, signal: controller.signal });

        // Wrap body-consuming methods so the abort timer stays alive during body reads.
        const wrapBodyMethod = <T>(fn: () => Promise<T>): Promise<T> =>
            fn().then(
                (result) => {
                    clearTimeout(timeoutId);
                    return result;
                },
                (err: unknown) => {
                    clearTimeout(timeoutId);
                    if ((err as Error).name === "AbortError") {
                        throw new Error(`Request to ${url} timed out after ${ms}ms (during body read)`);
                    }
                    throw err;
                },
            );

        return new Proxy(rawResponse, {
            get(target, prop) {
                if (prop === "json") return () => wrapBodyMethod(() => target.json());
                if (prop === "text") return () => wrapBodyMethod(() => target.text());
                if (prop === "arrayBuffer") return () => wrapBodyMethod(() => target.arrayBuffer());
                if (prop === "blob") return () => wrapBodyMethod(() => target.blob());

                const value = Reflect.get(target, prop);
                if (typeof value === "function") {
                    return value.bind(target);
                }
                return value;
            },
        });
    } catch (err) {
        clearTimeout(timeoutId);
        if ((err as Error).name === "AbortError") {
            throw new Error(`Request to ${url} timed out after ${ms}ms`);
        }
        throw err;
    }
}
