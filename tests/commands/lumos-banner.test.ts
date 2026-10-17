import { BANNER_TAGLINE, BANNER_WIDTH, renderLumosBanner } from "../../src/commands/lumos-banner";

/** The banner is coloured; the shape is what these check. */
const plain = (line: string) => line.replace(/\u001b\[[0-9;]*m/g, "");

describe("Lumos banner", () => {
    it("draws LUMOS in block letters on a terminal wide enough, with the tagline beneath", () => {
        const lines = renderLumosBanner(100).map(plain);

        // The last row of the letters is all shadow, so it has no solid block in it.
        const art = lines.filter((line) => /[█╚]/.test(line));
        expect(art).toHaveLength(6);
        for (const row of art) expect(row.trim()).toHaveLength(BANNER_WIDTH);
        expect(lines.some((line) => line.includes("Lumos") && line.includes(BANNER_TAGLINE))).toBe(true);
    });

    it("falls back to one line where the letters would wrap", () => {
        const lines = renderLumosBanner(40).map(plain);

        expect(lines.some((line) => line.includes("█"))).toBe(false);
        expect(lines.join("\n")).toContain(`LUMOS · ${BANNER_TAGLINE}`);
    });

    it("fits an 80-column terminal with its margins", () => {
        expect(BANNER_WIDTH + 4).toBeLessThanOrEqual(80);
    });
});
