import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Markdown } from "./markdown";

const html = (text: string) => render(<Markdown text={text} />).container;

describe("Markdown", () => {
  it("formats bold, italic and code", () => {
    const c = html("Use **bold**, *italic*, _also italic_ and `code`.");
    expect(c.querySelector("strong")?.textContent).toBe("bold");
    expect(Array.from(c.querySelectorAll("em"), (e) => e.textContent)).toEqual(["italic", "also italic"]);
    expect(c.querySelector("code")?.textContent).toBe("code");
  });

  it("builds headings, paragraphs with line breaks, and lists", () => {
    const c = html("# Today\nline one\nline two\n\n- a\n* b\n1. first\n2) second");
    expect(c.querySelector("p.h")?.textContent).toBe("Today");
    const para = c.querySelectorAll("p")[1];
    expect(para.querySelectorAll("br")).toHaveLength(1);
    expect(para.textContent).toBe("line oneline two");
    expect(Array.from(c.querySelectorAll("ul li"), (l) => l.textContent)).toEqual(["a", "b"]);
    expect(Array.from(c.querySelectorAll("ol li"), (l) => l.textContent)).toEqual(["first", "second"]);
  });

  it("links only to web pages, opening outside the app", () => {
    const c = html("[docs](https://example.com/a) and [bad](javascript:alert(1)) and [file](file:///C:/x)");
    const links = c.querySelectorAll("a");
    expect(links).toHaveLength(1);
    expect(links[0].getAttribute("href")).toBe("https://example.com/a");
    expect(links[0].getAttribute("target")).toBe("_blank");
    expect(links[0].getAttribute("rel")).toContain("noopener");
    expect(c.textContent).toContain("[bad](javascript:alert(1))");
  });

  it("never renders raw HTML from a reply", () => {
    const c = html('<img src=x onerror="alert(1)"> <script>alert(2)</script> **<b>hi</b>**');
    expect(c.querySelector("img, script, b")).toBeNull();
    expect(c.textContent).toContain('<img src=x onerror="alert(1)">');
    expect(c.querySelector("strong")?.textContent).toBe("<b>hi</b>");
  });
});
