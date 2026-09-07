import { Service } from "typedi";
import TurndownService from "turndown";
import { gfm } from "turndown-plugin-gfm";

/**
 * Converts Confluence storage-format HTML (and plain HTML) to Markdown.
 *
 * Confluence's storage format mixes standard HTML with XML-namespaced macro elements
 * (ac:structured-macro, ac:link, ri:user, ri:page, ac:image, ...) that no HTML parser
 * understands natively. Those are rewritten into plain HTML equivalents in a pre-processing
 * pass; the rest — headings, emphasis, links, tables, and crucially nested lists — is handled
 * by turndown (a real HTML→Markdown converter) instead of a regex pipeline, which cannot
 * correctly track nesting depth.
 */
@Service()
export class HtmlNormalizerService {
    private readonly turndown: TurndownService;

    constructor() {
        this.turndown = new TurndownService({
            headingStyle: "atx",
            codeBlockStyle: "fenced",
            bulletListMarker: "-",
            emDelimiter: "*",
        });
        this.turndown.use(gfm);

        // turndown-plugin-gfm's strikethrough rule emits single-tilde ~text~; use the more
        // widely-rendered double-tilde ~~text~~ GFM form instead.
        this.turndown.addRule("strikethrough", {
            filter: ["del", "s", "strike"],
            replacement: (content) => `~~${content}~~`,
        });

        // turndown has no default rule for a bare <pre> (no nested <code>) — without one its
        // content passes through as plain text with no fencing at all.
        this.turndown.addRule("barePre", {
            filter: (node) => node.nodeName === "PRE" && !node.querySelector("code"),
            replacement: (content) => `\n\`\`\`\n${content}\n\`\`\`\n`,
        });

        // Default list-item spacing pads the marker to align continuation lines ("-   item"),
        // which is valid but noisy. Use a single space after the marker instead.
        this.turndown.addRule("listItem", {
            filter: "li",
            replacement: (content, node, options) => {
                const cleaned = content.replace(/^\n+/, "").replace(/\n+$/, "\n").replace(/\n/gm, "\n    ");
                const parent = node.parentNode as {
                    nodeName?: string;
                    getAttribute?(name: string): string | null;
                    children?: ArrayLike<unknown>;
                } | null;
                const isOrdered = parent?.nodeName === "OL";
                let prefix = `${options.bulletListMarker} `;
                if (isOrdered && parent) {
                    const start = parent.getAttribute?.("start");
                    const index = parent.children ? Array.prototype.indexOf.call(parent.children, node) : 0;
                    prefix = `${start ? Number(start) + index : index + 1}. `;
                }
                return prefix + cleaned + (node.nextSibling && !/\n$/.test(cleaned) ? "\n" : "");
            },
        });
    }

    public convertHtmlToMarkdown(html: string): string {
        if (!html) return "";

        const preprocessed = this.preprocessConfluenceMacros(html);
        const markdown = this.turndown.turndown(preprocessed);

        return markdown
            .replace(/\u00A0/g, " ")
            .replace(/\n{3,}/g, "\n\n")
            .trim();
    }

    /**
     * Rewrites Confluence's XML-namespaced macro elements into plain HTML so turndown (a
     * standard HTML→Markdown converter) can handle everything else. Any macro element left
     * unrecognized is stripped rather than leaked into the output as literal tag text.
     */
    private preprocessConfluenceMacros(html: string): string {
        return (
            html
                .replace(
                    /<ac:plain-text-body>\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*<\/ac:plain-text-body>/gi,
                    (_, code: string) => `<pre><code>${this.escapeHtml(code.trim())}</code></pre>`,
                )
                .replace(
                    /<ac:plain-text-body>([\s\S]*?)<\/ac:plain-text-body>/gi,
                    (_, code: string) => `<pre><code>${this.escapeHtml(code.trim())}</code></pre>`,
                )
                .replace(/<ac:parameter[^>]*>[\s\S]*?<\/ac:parameter>/gi, "")
                .replace(/<\/?ac:structured-macro[^>]*>/gi, "")
                // User mentions — several storage-format shapes, both Server (ri:username) and Cloud
                // (ri:account-id), with or without a CDATA display-name body.
                .replace(
                    /<ac:link>\s*<ri:user[^>]*\/?>\s*<ac:plain-text-link-body>\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*<\/ac:plain-text-link-body>\s*<\/ac:link>/gi,
                    "@$1",
                )
                .replace(
                    /<ac:link>\s*<ri:user[^>]*\/?>\s*<ac:link-body>([\s\S]*?)<\/ac:link-body>\s*<\/ac:link>/gi,
                    "@$1",
                )
                .replace(/<ac:link>\s*<ri:user[^>]*ri:username="([^"]*)"[^>]*\/?>\s*<\/ac:link>/gi, "@$1")
                .replace(/<ac:link>\s*<ri:user[^>]*ri:account-id="([^"]*)"[^>]*\/?>\s*<\/ac:link>/gi, "@$1")
                // Page links — <ac:link><ri:page ri:content-title="Title"/></ac:link>, optionally with
                // a display-text body.
                .replace(
                    /<ac:link>\s*<ri:page[^>]*ri:content-title="([^"]*)"[^>]*\/?>\s*<ac:plain-text-link-body>\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*<\/ac:plain-text-link-body>\s*<\/ac:link>/gi,
                    (_, title: string, text: string) => `<a href="#">${text || title}</a>`,
                )
                .replace(
                    /<ac:link>\s*<ri:page[^>]*ri:content-title="([^"]*)"[^>]*\/?>\s*<\/ac:link>/gi,
                    '<a href="#">$1</a>',
                )
                // Images — an attachment reference has no directly usable URL (it would need a
                // separate authenticated API call to resolve), so render it as a text placeholder
                // rather than a broken/empty Markdown image; an external URL becomes a real image.
                .replace(
                    /<ac:image[^>]*>\s*<ri:attachment[^>]*ri:filename="([^"]*)"[^>]*\/?>\s*<\/ac:image>/gi,
                    "[Image: $1]",
                )
                .replace(
                    /<ac:image[^>]*>\s*<ri:url[^>]*ri:value="([^"]*)"[^>]*\/?>\s*<\/ac:image>/gi,
                    '<img src="$1" alt="image">',
                )
                .replace(/<\/?ac:image[^>]*>/gi, "")
                // Any remaining macro/resource-identifier element (unrecognized macro types, emoji,
                // status lozenges, etc.) — drop the tags but keep their text content rather than
                // leaking raw XML into the output.
                .replace(/<\/?ac:[a-z0-9-]+(?:\s[^>]*)?\/?>/gi, "")
                .replace(/<\/?ri:[a-z0-9-]+(?:\s[^>]*)?\/?>/gi, "")
        );
    }

    private escapeHtml(str: string): string {
        return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    }
}
