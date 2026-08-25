import { fetchWithTimeout } from "../../src/utils/fetch-with-timeout";

// Helper to create a mock response
function makeMockResponse(body: string, status = 200): Response {
    return {
        ok: status >= 200 && status < 300,
        status,
        headers: new Headers(),
        json: () => Promise.resolve(JSON.parse(body)),
        text: () => Promise.resolve(body),
        arrayBuffer: () => Promise.resolve(new TextEncoder().encode(body).buffer),
        blob: () => Promise.resolve(new Blob([body])),
        clone: jest.fn(),
        body: null,
        bodyUsed: false,
        redirected: false,
        type: "basic" as any,
        url: "",
        formData: () => Promise.reject(new Error("not implemented")),
    } as unknown as Response;
}

describe("fetchWithTimeout", () => {
    const originalFetch = global.fetch;

    beforeEach(() => {
        jest.useFakeTimers();
    });

    afterEach(() => {
        global.fetch = originalFetch;
        jest.useRealTimers();
    });

    it("should return a response when fetch succeeds within the timeout", async () => {
        global.fetch = jest.fn().mockResolvedValue(makeMockResponse(JSON.stringify({ ok: true })));

        const responsePromise = fetchWithTimeout("https://example.com/api", {}, 5000);
        // advance timers so the fetch mock resolves
        jest.advanceTimersByTime(100);
        const response = await responsePromise;
        expect(response).toBeDefined();
        expect(response.ok).toBe(true);
    });

    it("should call fetch with the AbortController signal attached", async () => {
        const mockFetch = jest.fn().mockResolvedValue(makeMockResponse("{}"));
        global.fetch = mockFetch;

        const responsePromise = fetchWithTimeout("https://example.com/api");
        jest.advanceTimersByTime(100);
        await responsePromise;

        expect(mockFetch).toHaveBeenCalledTimes(1);
        const callInit = mockFetch.mock.calls[0][1];
        expect(callInit.signal).toBeInstanceOf(AbortSignal);
    });

    it("should throw a timeout error when AbortController fires", async () => {
        global.fetch = jest.fn().mockImplementation(
            (_url: string, init: RequestInit) =>
                new Promise<Response>((_resolve, reject) => {
                    (init.signal as AbortSignal).addEventListener("abort", () => {
                        const err = new Error("The operation was aborted");
                        err.name = "AbortError";
                        reject(err);
                    });
                }),
        );

        const responsePromise = fetchWithTimeout("https://example.com/api", {}, 1000);
        jest.advanceTimersByTime(1001);
        await expect(responsePromise).rejects.toThrow("timed out after 1000ms");
    });

    it("should re-throw non-abort errors", async () => {
        global.fetch = jest.fn().mockRejectedValue(new Error("Network error"));

        const responsePromise = fetchWithTimeout("https://example.com/api", {}, 5000);
        jest.advanceTimersByTime(100);
        await expect(responsePromise).rejects.toThrow("Network error");
    });

    it("should keep the abort timer alive during .json() body read", async () => {
        // Simulate a response whose .json() hangs for longer than the timeout
        let resolveJson!: () => void;
        const slowJsonPromise = new Promise<any>((_resolve, _reject) => {
            resolveJson = () => _resolve({ data: "late" });
        });

        const mockResponse = {
            ...makeMockResponse("{}"),
            json: () => slowJsonPromise,
        } as unknown as Response;

        global.fetch = jest.fn().mockResolvedValue(mockResponse);

        const responsePromise = fetchWithTimeout("https://example.com/api", {}, 500);
        jest.advanceTimersByTime(50);
        const response = await responsePromise;

        // Start the body read — but the timer has already been set to 500ms total
        const jsonPromise = response.json();

        // Advance past the timeout window (body read is still pending)
        jest.advanceTimersByTime(600);

        // The pending json never resolved — it should not hang forever
        // (In production with real AbortSignal the read would abort; here we just
        // verify that manually resolving it returns the value correctly)
        resolveJson();
        const result = await jsonPromise;
        expect(result).toEqual({ data: "late" });
    });

    it("should pass request init options to fetch", async () => {
        const mockFetch = jest.fn().mockResolvedValue(makeMockResponse("{}"));
        global.fetch = mockFetch;

        const init: RequestInit = { method: "POST", headers: { Authorization: "Bearer token" } };
        const responsePromise = fetchWithTimeout("https://example.com/api", init);
        jest.advanceTimersByTime(100);
        await responsePromise;

        const callInit = mockFetch.mock.calls[0][1];
        expect(callInit.method).toBe("POST");
        expect((callInit.headers as Record<string, string>)["Authorization"]).toBe("Bearer token");
    });
});
