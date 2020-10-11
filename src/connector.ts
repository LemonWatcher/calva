import * as vscode from 'vscode';
import * as _ from 'lodash';
import * as fs from 'fs';
import * as state from './state';
import * as util from './utilities';
import * as open from 'open';
import status from './status';
import * as projectTypes from './nrepl/project-types';
import { NReplClient, NReplSession } from "./nrepl";
import { CljsTypeConfig, ReplConnectSequence, getDefaultCljsType, CljsTypes, askForConnectSequence } from './nrepl/connectSequence';
import { disabledPrettyPrinter } from './printer';
import { keywordize } from './util/string';
import { REQUESTS, initializeDebugger } from './debugger/calva-debug';
import * as outputWindow from './results-output/results-doc'
import evaluate from './evaluate';
import * as namespace from './namespace';

async function connectToHost(hostname: string, port: number, connectSequence: ReplConnectSequence) {
    state.analytics().logEvent("REPL", "Connecting").send();

    if (nClient) {
        nClient["silent"] = true;
        nClient.close();
    }
    cljsSession = cljSession = null;

    util.setConnectingState(true);
    status.update();
    try {
        outputWindow.append("; Hooking up nREPL sessions...");
        // Create an nREPL client. waiting for the connection to be established.
        nClient = await NReplClient.create({ host: hostname, port: +port, onError: e => {
            const scheme = state.getProjectRootUri().scheme
            if (scheme == "vsls") {
                outputWindow.append("; nREPL connection failed; did the host share the nREPL port?")
            }
        }})
        nClient.addOnCloseHandler(c => {
            util.setConnectedState(false);
            util.setConnectingState(false);
            if (!c["silent"]) // we didn't deliberately close this session, mention this fact.
                outputWindow.append("; nREPL Connection was closed");
            status.update();
        })
        cljSession = nClient.session;
        cljSession.replType = 'clj';
        util.setConnectingState(false);
        util.setConnectedState(true);
        state.analytics().logEvent("REPL", "ConnectedCLJ").send();
        state.cursor.set('clj', cljSession);
        state.cursor.set('cljc', cljSession);
        status.update();
        outputWindow.append(`; Connected session: clj\n${outputWindow.CLJ_CONNECT_GREETINGS}`);
        namespace.updateREPLSessionType();

        await initializeDebugger(cljSession);

        outputWindow.setSession(cljSession, nClient.ns);

        if (connectSequence.afterCLJReplJackInCode) {
            outputWindow.append(`; Evaluating 'afterCLJReplJackInCode'`);
            await evaluate.evaluateInOutputWindow(connectSequence.afterCLJReplJackInCode, 'clj', outputWindow.getNs());
        }

        let cljsSession = null,
            cljsBuild = null;
        try {
            if (connectSequence.cljsType && connectSequence.cljsType != "none") {
                const isBuiltinType: boolean = typeof connectSequence.cljsType == "string";
                let cljsType: CljsTypeConfig = isBuiltinType ? getDefaultCljsType(connectSequence.cljsType as string) : connectSequence.cljsType as CljsTypeConfig;
                translatedReplType = createCLJSReplType(cljsType, projectTypes.getCljsTypeName(connectSequence), connectSequence);

                [cljsSession, cljsBuild] = await makeCljsSessionClone(cljSession, translatedReplType, connectSequence.name);
                state.analytics().logEvent("REPL", "ConnectCljsRepl", isBuiltinType ? connectSequence.cljsType as string : "Custom").send();
            }
            if (cljsSession) {
                await setUpCljsRepl(cljsSession, cljsBuild);
            }
        } catch (e) {
            outputWindow.append("; Error while connecting cljs REPL: " + e);
        }
        status.update();
    } catch (e) {
        util.setConnectingState(false);
        util.setConnectedState(false);
        outputWindow.append("; Failed connecting.");
        state.analytics().logEvent("REPL", "FailedConnectingCLJ").send();
        return false;
    }

    return true;
}

async function setUpCljsRepl(session, build) {
    state.cursor.set("cljs", session);
    status.update();
    outputWindow.append(`; Connected session: cljs${(build ? ", repl: " + build : "")}\n${outputWindow.CLJS_CONNECT_GREETINGS}`);
    outputWindow.setSession(session, 'cljs.user');
    namespace.updateREPLSessionType();
}

async function getFigwheelMainBuilds() {
    let res = await vscode.workspace.fs.readDirectory(state.getProjectRootUri())
    let builds = res
        .filter(([name, type]) => type != vscode.FileType.Directory && name.match(/\.cljs\.edn/))
        .map(([name, _]) => name.replace(/\.cljs\.edn$/, ""));
    if (builds.length == 0) {
        vscode.window.showErrorMessage("There are no figwheel build files (.cljs.edn) in the project directory.");
        outputWindow.append("; There are no figwheel build files (.cljs.edn) in the project directory.");
        outputWindow.append("; Connection to Figwheel Main aborted.");
        throw "Aborted";
    }
    return builds;
}

/**
 * ! DO it later
 */
function getFigwheelBuilds() {

}

type checkConnectedFn = (value: string, out: any[], err: any[]) => boolean;
type processOutputFn = (output: string) => void;
type connectFn = (session: NReplSession, name: string, checkSuccess: checkConnectedFn) => Promise<boolean>;

async function evalConnectCode(newCljsSession: NReplSession, code: string, name: string, checkSuccess: checkConnectedFn, outputProcessors: processOutputFn[] = [], errorProcessors: processOutputFn[] = []): Promise<boolean> {
    let chan = state.connectionLogChannel();
    let err = [], out = [], result = await newCljsSession.eval(code, "user", {
        stdout: x => {
            out.push(util.stripAnsi(x));
            chan.append(util.stripAnsi(x));
            for (const p of outputProcessors) {
                p(util.stripAnsi(x));
            }
        }, stderr: x => {
            err.push(util.stripAnsi(x));
            chan.append(util.stripAnsi(x));
            for (const p of errorProcessors) {
                p(util.stripAnsi(x));
            }
        },
        pprintOptions: disabledPrettyPrinter
    });
    let valueResult = await result.value
        .catch(reason => {
            console.error("Error evaluating connect form: ", reason);
        });
    if (checkSuccess(valueResult, out, err)) {
        state.analytics().logEvent("REPL", "ConnectedCLJS", name).send();
        state.cursor.set('cljs', cljsSession = newCljsSession)
        return true
    } else {
        return false;
    }
}

export interface ReplType {
    name: string,
    start?: connectFn;
    started?: (valueResult: string, out: string[], err: string[]) => boolean;
    connect?: connectFn;
    connected: (valueResult: string, out: string[], err: string[]) => boolean;
}

let translatedReplType: ReplType;

async function figwheelOrShadowBuilds(cljsTypeName: string): Promise<string[]> {
    if (cljsTypeName.includes("Figwheel Main")) {
        return await getFigwheelMainBuilds();
    } else if (cljsTypeName.includes("shadow-cljs")) {
        return await projectTypes.shadowBuilds();
    }
}

function updateInitCode(build: string, initCode): string {
    if (build && typeof initCode === 'object') {
        if (["node-repl", "browser-repl"].includes(build)) {
            return initCode.repl.replace("%REPL%", build);
        } else {
            return initCode.build.replace("%BUILD%", keywordize(build));
        }
    } else if (build && typeof initCode === 'string') {
        return initCode.replace("%BUILD%", `"${build}"`);
    }
    return null;
}

function createCLJSReplType(cljsType: CljsTypeConfig, cljsTypeName: string, connectSequence: ReplConnectSequence): ReplType {
    const projectTypeName: string = connectSequence.name,
        menuSelections = connectSequence.menuSelections;
    let appURL: string,
        haveShownStartMessage = false,
        haveShownAppURL = false,
        haveShownStartSuffix = false,
        hasStarted = cljsType.isStarted,
        useDefaultBuild = true,
        startedBuilds: string[];
        // The output processors are used to keep the user informed about the connection process
        // The output from Figwheel is meant for printing to the REPL prompt,
        // and since we print to Calva says we, only print some of the messages.
    const printThisPrinter: processOutputFn = x => {
            if (cljsType.printThisLineRegExp) {
                if (x.search(cljsType.printThisLineRegExp) >= 0) {
                    outputWindow.append('; ' + x.replace(/\s*$/, ""));
                }
            }
        },
        // Having and app to connect to is crucial so we do what we can to help the user
        // start the app at the right time in the process.
        startAppNowProcessor: processOutputFn = x => {
            // Extract the appURL if we have the regexp for it configured.
            if (cljsType.openUrlRegExp) {
                const matched = util.stripAnsi(x).match(cljsType.openUrlRegExp);
                if (matched && matched["groups"] && matched["groups"].url != undefined) {
                    if (matched["groups"].url != appURL) {
                        appURL = matched["groups"].url;
                        haveShownAppURL = false;
                    }
                }
            }
            // When the app is ready to start, say so.
            if (!haveShownStartMessage && cljsType.isReadyToStartRegExp) {
                if (x.search(cljsType.isReadyToStartRegExp) >= 0) {
                    outputWindow.append("; CLJS REPL ready to connect. Please, start your ClojureScript app.");
                    haveShownStartMessage = true;
                }
            }
            // If we have an appURL to go with the ”start now” message, say so
            if (appURL && haveShownStartMessage && !haveShownAppURL) {
                if (cljsType.shouldOpenUrl) {
                    outputWindow.append(`; Opening ClojureScript app in the browser at: ${appURL} ...`);
                    open(appURL).catch(reason => {
                        outputWindow.append("; Error opening ClojureScript app in the browser: " + reason);
                    });
                } else {
                    outputWindow.append(";   Open the app on this URL: " + appURL);
                }
                haveShownAppURL = true;
            }
            // Wait for any appURL to be printed before we round of the ”start now” message.
            // (If we do not have the regexp for extracting the appURL, do not wait for appURL.)
            if (!haveShownStartSuffix && (haveShownAppURL || (haveShownStartMessage && !cljsType.openUrlRegExp))) {
                outputWindow.append(";   The CLJS REPL will connect when your app is running.");
                haveShownStartSuffix = true;
            }
        },
        // This processor prints everything. We use it for stderr below.
        allPrinter: processOutputFn = x => {
            outputWindow.append('; ' + util.stripAnsi(x).replace(/\s*$/, ""));
        }

    let replType: ReplType = {
        name: cljsTypeName,
        connect: async (session, name, checkFn) => {
            state.extensionContext.workspaceState.update('cljsReplTypeHasBuilds', cljsType.buildsRequired);
            let initCode = cljsType.connectCode,
                build: string = null;
            if (menuSelections && menuSelections.cljsDefaultBuild && useDefaultBuild) {
                build = menuSelections.cljsDefaultBuild;
                useDefaultBuild = false;
            } else {
                if ((typeof initCode === 'object' || initCode.includes("%BUILD%"))) {
                    build = await util.quickPickSingle({
                        values: startedBuilds ? startedBuilds : await figwheelOrShadowBuilds(cljsTypeName),
                        placeHolder: "Select which build to connect to",
                        saveAs: `${state.getProjectRootUri().toString()}/${cljsTypeName.replace(" ", "-")}-build`,
                        autoSelect: true
                    });
                }
            }

            if ((typeof build == 'string') && build != "") {
                initCode = updateInitCode(build, initCode);
                if (!initCode) {
                    //TODO error message
                    return;
                }
            }

            if (!(typeof initCode == 'string')) {
                //TODO error message
                return;
            }

            state.cursor.set('cljsBuild', build);

            return evalConnectCode(session, initCode, name, checkFn, [startAppNowProcessor, printThisPrinter], [allPrinter]);
        },
        connected: (result, out, err) => {
            if (cljsType.isConnectedRegExp) {
                return [...out, result].find(x => {
                    return x.search(cljsType.isConnectedRegExp) >= 0
                }) != undefined;
            } else {
                return true;
            }
        }
    };

    if (cljsType.startCode) {
        replType.start = async (session, name, checkFn) => {
            let startCode = cljsType.startCode;
            if (!hasStarted) {
                if (startCode.includes("%BUILDS")) {
                    let builds: string[];
                    if (menuSelections && menuSelections.cljsLaunchBuilds) {
                        builds = menuSelections.cljsLaunchBuilds;
                    }
                    else {
                        const allBuilds = await figwheelOrShadowBuilds(cljsTypeName);
                        builds = allBuilds.length <= 1 ? allBuilds : await util.quickPickMulti({
                            values: allBuilds,
                            placeHolder: "Please select which builds to start",
                            saveAs: `${state.getProjectRootUri().toString()}/${cljsTypeName.replace(" ", "-")}-builds`
                        });
                    }
                    if (builds) {
                        outputWindow.append("; Starting cljs repl for: " + projectTypeName + "...");
                        state.extensionContext.workspaceState.update('cljsReplTypeHasBuilds', true);
                        startCode = startCode.replace("%BUILDS%", builds.map(x => { return `"${x}"` }).join(" "));
                        const result = evalConnectCode(session, startCode, name, checkFn, [startAppNowProcessor, printThisPrinter], [allPrinter]);
                        if (result) {
                            startedBuilds = builds;
                        }
                        return result;
                    } else {
                        outputWindow.append("; Aborted starting cljs repl.");
                        throw "Aborted";
                    }
                } else {
                    outputWindow.append("; Starting cljs repl for: " + projectTypeName + "...");
                    return evalConnectCode(session, startCode, name, checkFn, [startAppNowProcessor, printThisPrinter], [allPrinter]);
                }
            } else {
                return true;
            }
        };
    }

    replType.started = (result, out, err) => {
        if (cljsType.isReadyToStartRegExp && !hasStarted) {
            const started = [...out, ...err].find(x => {
                return x.search(cljsType.isReadyToStartRegExp) >= 0
            }) != undefined;
            if (started) {
                hasStarted = true;
            }
            return started;
        } else {
            hasStarted = true;
            return true;
        }
    }

    return replType;
}

async function makeCljsSessionClone(session, repl: ReplType, projectTypeName: string) {
    outputWindow.append("; Creating cljs repl session...");
    let newCljsSession = await session.clone();
    newCljsSession.replType = 'cljs';
    if (newCljsSession) {
        outputWindow.append("; Connecting cljs repl: " + projectTypeName + "...");
        outputWindow.append(";   The Calva Connection Log might have more connection progress information.");
        if (repl.start != undefined) {
            if (await repl.start(newCljsSession, repl.name, repl.started)) {
                state.analytics().logEvent("REPL", "StartedCLJS", repl.name).send();
                outputWindow.append("; Cljs builds started");
                newCljsSession = await session.clone();
            } else {
                state.analytics().logEvent("REPL", "FailedStartingCLJS", repl.name).send();
                outputWindow.append("; Failed starting cljs repl");
                state.cursor.set('cljsBuild', null);
                return [null, null];
            }
        }
        if (await repl.connect(newCljsSession, repl.name, repl.connected)) {
            state.analytics().logEvent("REPL", "ConnectedCLJS", repl.name).send();
            state.cursor.set('cljs', cljsSession = newCljsSession);
            return [cljsSession, state.deref().get('cljsBuild')];
        } else {
            let build = state.deref().get('cljsBuild')
            state.analytics().logEvent("REPL", "FailedConnectingCLJS", repl.name).send();
            let failed = "Failed starting cljs repl" + (build != null ? ` for build: ${build}. Is the build running and connected?\n   See the Output channel "Calva Connection Log" for any hints on what went wrong.` : "");
            outputWindow.append(`; ${failed}`);
            state.cursor.set('cljsBuild', null);
            vscode.window.showInformationMessage(
                failed,
                { modal: true },
                ...["Ok"]).then((value) => {
                    if (value == 'Ok') {
                        const outputChannel = state.connectionLogChannel();
                        outputChannel.show();
                    }
                });
        }
    }
    return [null, null];
}

async function promptForNreplUrlAndConnect(port, connectSequence: ReplConnectSequence) {
    let current = state.deref();

    let url = await vscode.window.showInputBox({
        placeHolder: "Enter existing nREPL hostname:port here...",
        prompt: "Add port to nREPL if localhost, otherwise 'hostname:port'",
        value: "localhost:" + (port ? port : ""),
        ignoreFocusOut: true
    })
    // state.reset(); TODO see if this should be done
    if (url !== undefined) {
        let [hostname, port] = url.split(':'),
            parsedPort = parseFloat(port);
        if (parsedPort && parsedPort > 0 && parsedPort < 65536) {
            state.cursor.set("hostname", hostname);
            state.cursor.set("port", parsedPort);
            await connectToHost(hostname, parsedPort, connectSequence);
        } else {
            outputWindow.append("; Bad url: " + url);
            util.setConnectingState(false);
            status.update();
        }
    } else {
        util.setConnectingState(false);
        status.update();
    }
    return true;
}

export let nClient: NReplClient;
export let cljSession: NReplSession;
export let cljsSession: NReplSession;

export async function connect(connectSequence: ReplConnectSequence, isAutoConnect: boolean) {
    const cljsTypeName = projectTypes.getCljsTypeName(connectSequence);

    state.analytics().logEvent("REPL", "ConnectInitiated", isAutoConnect ? "auto" : "manual");
    state.analytics().logEvent("REPL", "ConnectInitiated", cljsTypeName).send();

    const portFile = projectTypes.nreplPortFileUri(connectSequence);

    state.extensionContext.workspaceState.update('selectedCljsTypeName', cljsTypeName);
    state.extensionContext.workspaceState.update('selectedConnectSequence', connectSequence);

    try {
        let bytes = await vscode.workspace.fs.readFile(portFile);
        let port = new TextDecoder("utf-8").decode(bytes);
        if (port) {
            if (isAutoConnect) {
                state.cursor.set("hostname", "localhost");
                state.cursor.set("port", port);
                await connectToHost("localhost", parseInt(port), connectSequence);
            } else {
                await promptForNreplUrlAndConnect(port, connectSequence);
            }
        } else {
            outputWindow.append('; No nrepl port file found. (Calva does not start the nrepl for you, yet.)');
            await promptForNreplUrlAndConnect(port, connectSequence);
        }
    } catch (e) {
        console.log(e)
        await promptForNreplUrlAndConnect(null, connectSequence);
    }
    return true;

}

async function standaloneConnect(connectSequence: ReplConnectSequence) {
    await outputWindow.initResultsDoc();
    const outputDocument = await outputWindow.openResultsDoc();

    if (connectSequence) {
        const cljsTypeName = projectTypes.getCljsTypeName(connectSequence);
        outputWindow.append(`; Connecting ...`);
        state.analytics().logEvent("REPL", "StandaloneConnect", `${connectSequence.name} + ${cljsTypeName}`).send();
        connect(connectSequence, false).catch(() => { });
    }
    else {
        outputWindow.append("; Aborting connect, error determining connect sequence.");
    }
}

export default {
    connectNonProjectREPLCommand: async () => {
        const connectSequence = await askForConnectSequence(projectTypes.getAllProjectTypes(), 'connect-type', "ConnectInterrupted");
        standaloneConnect(connectSequence);
    },
    connectCommand: async () => {
        // TODO: Figure out a better way to have an initialized project directory.
        try {
            await state.initProjectDir();
        } catch {
            // Could be a bae file, user makes the call
            vscode.commands.executeCommand('calva.jackInOrConnect');
            return;
        }
        const cljTypes = await projectTypes.detectProjectTypes(),
            connectSequence = await askForConnectSequence(cljTypes, 'connect-type', "ConnectInterrupted");
        standaloneConnect(connectSequence);
    },
    disconnect: (options = null, callback = () => { }) => {
        ['clj', 'cljs'].forEach(sessionType => {
            state.cursor.set(sessionType, null);
        });
        util.setConnectedState(false);
        state.cursor.set('cljc', null);
        status.update();

        if (nClient) {
            if (state.getProjectRootUri().scheme == "vsls") {
                nClient.disconnect();
            } else {
                // the connection may be ended before
                // the REPL client was connected.
                nClient.close();
            }
            nClient = undefined
        }

        // If an active debug session exists, terminate it
        if (vscode.debug.activeDebugSession) {
            vscode.debug.activeDebugSession.customRequest(REQUESTS.SEND_TERMINATED_EVENT);
        }

        callback();
    },
    toggleCLJCSession: () => {
        let current = state.deref();
        let newSession: NReplSession;

        if (current.get('connected')) {
            if (namespace.getSession('cljc') == namespace.getSession('cljs')) {
                newSession = namespace.getSession('clj');
            } else if (namespace.getSession('cljc') == namespace.getSession('clj')) {
                newSession = namespace.getSession('cljs');
            }
            state.cursor.set('cljc', newSession);
            if (outputWindow.isResultsDoc(vscode.window.activeTextEditor.document)) {
                outputWindow.setSession(newSession, undefined);
                namespace.updateREPLSessionType();
            }
            status.update();
        }
    },
    switchCljsBuild: async () => {
        let cljSession = namespace.getSession('clj');
        const cljsTypeName: string = state.extensionContext.workspaceState.get('selectedCljsTypeName'),
            cljTypeName: string = state.extensionContext.workspaceState.get('selectedCljTypeName');
        state.analytics().logEvent("REPL", "switchCljsBuild", cljsTypeName).send();

        let [session, build] = await makeCljsSessionClone(cljSession, translatedReplType, cljTypeName);
        if (session) {
            await setUpCljsRepl(session, build);
        }
        status.update();
    }
};
