import * as colors from "yoctocolors-cjs";

/**
 * The welcome banner for the chat: "LUMOS" in block letters, drawn by hand so it costs no
 * dependency. The solid blocks are each letter's lit face and the box-drawing strokes its
 * shadow, which is the one bit of theatre the name asks for.
 */
const ROWS = [
    "██╗     ██╗   ██╗███╗   ███╗ ██████╗ ███████╗",
    "██║     ██║   ██║████╗ ████║██╔═══██╗██╔════╝",
    "██║     ██║   ██║██╔████╔██║██║   ██║███████╗",
    "██║     ██║   ██║██║╚██╔╝██║██║   ██║╚════██║",
    "███████╗╚██████╔╝██║ ╚═╝ ██║╚██████╔╝███████║",
    "╚══════╝ ╚═════╝ ╚═╝     ╚═╝ ╚═════╝ ╚══════╝",
];

/** Columns the block letters take; they are drawn behind MARGIN on each side. */
export const BANNER_WIDTH = ROWS[0].length;
const MARGIN = "  ";

export const BANNER_TAGLINE = "A mentor who has read the docs and the code.";

/**
 * The banner as lines to print, sized to the terminal: the block letters where they fit,
 * one line where they would wrap into noise.
 */
export function renderLumosBanner(columns: number): string[] {
    if (columns < BANNER_WIDTH + MARGIN.length * 2) {
        return ["", `${MARGIN}${colors.bold(colors.yellow("LUMOS"))} ${colors.dim("·")} ${BANNER_TAGLINE}`, ""];
    }
    const lit = (row: string) =>
        row.replace(/█+|[^█]+/g, (run) => (run.startsWith("█") ? colors.yellow(run) : colors.gray(run)));
    return [
        "",
        ...ROWS.map((row) => `${MARGIN}${lit(row)}`),
        "",
        `${MARGIN}${colors.bold("Lumos")} ${colors.dim("·")} ${BANNER_TAGLINE}`,
        `${MARGIN}${colors.dim("─".repeat(BANNER_WIDTH))}`,
        "",
    ];
}
