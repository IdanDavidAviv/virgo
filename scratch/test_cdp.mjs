import CDP from 'chrome-remote-interface';

async function test() {
    let client;
    try {
        client = await CDP({ port: 9222 });
        const { Runtime, Target } = client;

        const targets = await Target.getTargets();
        const webviewTarget = targets.targetInfos.find(t => t.url.includes('vscode-webview://'));

        if (!webviewTarget) {
            console.log("Webview target not found");
            return;
        }

        const webviewClient = await CDP({ target: webviewTarget.targetId });
        
        const eval1 = await webviewClient.Runtime.evaluate({
            expression: 'typeof window.__debug',
            returnByValue: true
        });
        console.log("typeof window.__debug:", eval1.result.value);

        if (eval1.result.value === 'object') {
            const eval2 = await webviewClient.Runtime.evaluate({
                expression: 'Object.keys(window.__debug)',
                returnByValue: true
            });
            console.log("window.__debug keys:", eval2.result.value);
        }

        await webviewClient.close();
    } catch (err) {
        console.error(err);
    } finally {
        if (client) await client.close();
    }
}

test();
