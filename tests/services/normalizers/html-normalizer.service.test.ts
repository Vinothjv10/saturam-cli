import { HtmlNormalizerService } from "../../../src/services/normalizers/html-normalizer.service";

describe("HtmlNormalizerService", () => {
    let normalizer: HtmlNormalizerService;

    beforeEach(() => {
        normalizer = new HtmlNormalizerService();
    });

    describe("convertHtmlToMarkdown", () => {
        it("should return empty string for empty input", () => {
            expect(normalizer.convertHtmlToMarkdown("")).toBe("");
        });

        it("should convert headings h1–h4", () => {
            const html = "<h1>Title</h1><h2>Section</h2><h3>Sub</h3><h4>Subsub</h4>";
            const md = normalizer.convertHtmlToMarkdown(html);
            expect(md).toContain("# Title");
            expect(md).toContain("## Section");
            expect(md).toContain("### Sub");
            expect(md).toContain("#### Subsub");
        });

        it("should convert bold and italic", () => {
            const html = "<p><strong>bold</strong> and <em>italic</em></p>";
            const md = normalizer.convertHtmlToMarkdown(html);
            expect(md).toContain("**bold**");
            expect(md).toContain("*italic*");
        });

        it("should convert <b> and <i> tags", () => {
            const html = "<b>boldB</b> <i>italicI</i>";
            const md = normalizer.convertHtmlToMarkdown(html);
            expect(md).toContain("**boldB**");
            expect(md).toContain("*italicI*");
        });

        it("should convert strikethrough", () => {
            const html = "<strike>struck</strike> and <del>deleted</del>";
            const md = normalizer.convertHtmlToMarkdown(html);
            expect(md).toContain("~~struck~~");
            expect(md).toContain("~~deleted~~");
        });

        it("should convert anchor links", () => {
            const html = '<a href="https://example.com">Click here</a>';
            const md = normalizer.convertHtmlToMarkdown(html);
            expect(md).toContain("[Click here](https://example.com)");
        });

        it("should convert inline code", () => {
            const html = "<code>const x = 1;</code>";
            const md = normalizer.convertHtmlToMarkdown(html);
            expect(md).toContain("`const x = 1;`");
        });

        it("should convert pre/code blocks to fenced code blocks", () => {
            const html = "<pre><code>function foo() {}</code></pre>";
            const md = normalizer.convertHtmlToMarkdown(html);
            expect(md).toContain("```");
            expect(md).toContain("function foo() {}");
        });

        it("should convert <pre> without <code> to fenced block", () => {
            const html = "<pre>plain preformatted text</pre>";
            const md = normalizer.convertHtmlToMarkdown(html);
            expect(md).toContain("```");
            expect(md).toContain("plain preformatted text");
        });

        it("should decode HTML entities", () => {
            const html = "&nbsp;&amp;&quot;&#39;&lt;&gt;";
            const md = normalizer.convertHtmlToMarkdown(html);
            expect(md).toContain("&");
            expect(md).toContain('"');
            expect(md).toContain("'");
            expect(md).toContain("<");
            expect(md).toContain(">");
        });

        it("should convert Confluence CDATA plain-text-body to fenced block", () => {
            const html = "<ac:plain-text-body><![CDATA[some code here]]></ac:plain-text-body>";
            const md = normalizer.convertHtmlToMarkdown(html);
            expect(md).toContain("```");
            expect(md).toContain("some code here");
        });

        it("should strip Confluence structured-macro tags", () => {
            const html = '<ac:structured-macro ac:name="code">content</ac:structured-macro>';
            const md = normalizer.convertHtmlToMarkdown(html);
            expect(md).not.toContain("<ac:structured-macro");
        });

        it("should collapse excessive blank lines", () => {
            const html = "<p>First</p><p></p><p></p><p></p><p>Second</p>";
            const md = normalizer.convertHtmlToMarkdown(html);
            // Should not have more than 2 consecutive newlines
            expect(md).not.toMatch(/\n{3,}/);
        });

        it("should strip remaining HTML tags", () => {
            const html = "<div><span>Hello</span></div>";
            const md = normalizer.convertHtmlToMarkdown(html);
            expect(md).toBe("Hello");
        });
    });

    describe("table conversion", () => {
        it("should convert a simple HTML table to Markdown", () => {
            const html = `
                <table>
                    <tr><th>Name</th><th>Role</th></tr>
                    <tr><td>Alice</td><td>Engineer</td></tr>
                    <tr><td>Bob</td><td>Designer</td></tr>
                </table>`;
            const md = normalizer.convertHtmlToMarkdown(html);
            expect(md).toContain("| Name | Role |");
            expect(md).toContain("| --- | --- |");
            expect(md).toContain("| Alice | Engineer |");
            expect(md).toContain("| Bob | Designer |");
        });
    });

    describe("list conversion", () => {
        it("should convert an unordered list", () => {
            const html = "<ul><li>Item A</li><li>Item B</li></ul>";
            const md = normalizer.convertHtmlToMarkdown(html);
            expect(md).toContain("- Item A");
            expect(md).toContain("- Item B");
        });

        it("should convert an ordered list with correctly incrementing numbers", () => {
            const html = "<ol><li>First</li><li>Second</li></ol>";
            const md = normalizer.convertHtmlToMarkdown(html);
            expect(md).toContain("1. First");
            expect(md).toContain("2. Second");
        });

        it("should handle line breaks with <br>", () => {
            const html = "Line one<br>Line two";
            const md = normalizer.convertHtmlToMarkdown(html);
            expect(md).toContain("Line one");
            expect(md).toContain("Line two");
        });

        it("should correctly nest a sub-list under its parent item instead of merging text", () => {
            const html = "<ul><li>A<ul><li>A1</li><li>A2</li></ul></li><li>B</li></ul>";
            const md = normalizer.convertHtmlToMarkdown(html);
            expect(md).toContain("- A");
            expect(md).toContain("- A1");
            expect(md).toContain("- A2");
            expect(md).toContain("- B");
            // A1/A2 must not be merged into A's own line, and must be indented under it.
            expect(md).not.toContain("AA1");
            expect(md).not.toMatch(/^- A1/m);
        });
    });

    describe("Confluence macro pre-processing", () => {
        it("should resolve a Cloud user mention by account ID to an @mention", () => {
            const html = '<ac:link><ri:user ri:account-id="abc123"/></ac:link>';
            const md = normalizer.convertHtmlToMarkdown(html);
            expect(md).toBe("@abc123");
        });

        it("should resolve a Server user mention by username to an @mention", () => {
            const html = '<ac:link><ri:user ri:username="jdoe"/></ac:link>';
            const md = normalizer.convertHtmlToMarkdown(html);
            expect(md).toBe("@jdoe");
        });

        it("should resolve a page link to a Markdown link with the page title", () => {
            const html = '<ac:link><ri:page ri:content-title="Onboarding Guide"/></ac:link>';
            const md = normalizer.convertHtmlToMarkdown(html);
            expect(md).toContain("[Onboarding Guide]");
        });

        it("should resolve an attached image to alt text instead of dropping it", () => {
            const html = '<ac:image><ri:attachment ri:filename="diagram.png"/></ac:image>';
            const md = normalizer.convertHtmlToMarkdown(html);
            expect(md).toContain("diagram.png");
        });

        it("should decode numeric and named HTML entities", () => {
            const html = "<p>It&#8217;s &copy; 2026</p>";
            const md = normalizer.convertHtmlToMarkdown(html);
            expect(md).toContain("It’s");
            expect(md).toContain("©");
        });

        it("should not leak unrecognized macro tags into the output", () => {
            const html = '<ac:emoticon ac:name="smile"/>hi';
            const md = normalizer.convertHtmlToMarkdown(html);
            expect(md).not.toContain("ac:emoticon");
        });
    });
});
