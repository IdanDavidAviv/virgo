"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const fuzzyMatcher_1 = require("../src/fuzzyMatcher");
function test() {
    console.log('--- FUZZY MATCHER DEBUG TRIAL ---');
    const rawMarkdown = `
# Heading 1
This is a **bold** and _italic_ sentence with a [link](https://google.com).
Another paragraph with some Hebrew: שלום עולם (Hello World).
- List item 1
- List item 2
> A quote from someone special.
    `.trim();
    const logger = (msg) => console.log(msg);
    const matcher = new fuzzyMatcher_1.FuzzyMatcher(rawMarkdown, logger);
    const testSentences = [
        "This is a bold and italic sentence with a link",
        "Another paragraph with some Hebrew: שלום עולם (Hello World)",
        "List item 1",
        "A quote from someone special"
    ];
    testSentences.forEach(s => {
        console.log(`\nSEARCHING FOR: "${s}"`);
        const range = matcher.findRange(s);
        if (range) {
            console.log(`SUCCESS: Found at range [${range.start}, ${range.end}]`);
            console.log(`EXTRACTED RAW: "${rawMarkdown.substring(range.start, range.end)}"`);
        }
        else {
            console.log('FAILURE: Not found.');
        }
    });
    console.log('\n--- COMPLEX NESTED TEST ---');
    const nestedRaw = "This **is _very_ nested [formatting](url)**.";
    const nestedMatcher = new fuzzyMatcher_1.FuzzyMatcher(nestedRaw, logger);
    const nestedSent = "This is very nested formatting.";
    const nestedRange = nestedMatcher.findRange(nestedSent);
    if (nestedRange) {
        console.log(`NESTED SUCCESS: "${nestedRaw.substring(nestedRange.start, nestedRange.end)}"`);
    }
    else {
        console.log('NESTED FAILURE');
    }
}
test();
//# sourceMappingURL=testFuzzy.js.map