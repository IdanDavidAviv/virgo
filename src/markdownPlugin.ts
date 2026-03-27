import * as vscode from 'vscode';

export function extendMarkdownIt(md: any) {
    // We add a custom renderer for opening tags of blocks to ensure a data-line attribute is present
    const originalOpen = md.renderer.rules.paragraph_open || 
                        ((tokens: any[], idx: number, options: any, env: any, self: any) => self.renderToken(tokens, idx, options));
    
    md.renderer.rules.paragraph_open = (tokens: any[], idx: number, options: any, env: any, self: any) => {
        const token = tokens[idx];
        if (token.map && token.map.length) {
            token.attrJoin('data-line', token.map[0].toString());
            token.attrJoin('class', 'ra-paragraph');
        }
        return originalOpen(tokens, idx, options, env, self);
    };

    // Do the same for headings
    const originalHeadingOpen = md.renderer.rules.heading_open || 
                                ((tokens: any[], idx: number, options: any, env: any, self: any) => self.renderToken(tokens, idx, options));

    md.renderer.rules.heading_open = (tokens: any[], idx: number, options: any, env: any, self: any) => {
        const token = tokens[idx];
        if (token.map && token.map.length) {
            token.attrJoin('data-line', token.map[0].toString());
        }
        return originalHeadingOpen(tokens, idx, options, env, self);
    };

    return md;
}
