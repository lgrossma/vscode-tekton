/*-----------------------------------------------------------------------------------------------
 *  Copyright (c) Red Hat, Inc. All rights reserved.
 *  Licensed under the MIT License. See LICENSE file in the project root for license information.
 *-----------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { contextGlobalState } from '../extension';
import * as path from 'path';
import { GraphProvider } from './pipeline-graph';
import { Disposable } from '../util/disposable';
import { debounce } from 'debounce';
import { kubectl } from '../kubectl';
import { PipelineRunData } from '../tekton';
import { NodeData } from '../webview/pipeline-preview/model';
import { VirtualDocument } from '../yaml-support/yaml-locator';
import { telemetryLogError } from '../telemetry';
import { TaskRun } from '../tekton/taskrun';

export interface PipelinePreviewInput {
  readonly document: vscode.TextDocument | VirtualDocument;
  readonly resourceColumn: vscode.ViewColumn;
  readonly line?: number;
  readonly graphProvider: GraphProvider;
  readonly pipelineRunName?: string;
  readonly pipelineRunStatus?: string;
}
export class PipelinePreview extends Disposable {
  static viewType = 'tekton.pipeline.preview';



  public static create(
    input: PipelinePreviewInput,
    previewColumn: vscode.ViewColumn): PipelinePreview {
    const webview = vscode.window.createWebviewPanel(
      PipelinePreview.viewType,
      `Preview ${path.basename(input.document.uri.fsPath)}`,
      previewColumn,
      {
        enableFindWidget: true,
        ...getWebviewOptions()
      });


    return new PipelinePreview(webview, input);
  }

  private editor: vscode.WebviewPanel;
  private document: vscode.TextDocument | VirtualDocument;
  private updateFunc = debounce(() => this.doUpdate(), 500);
  private graphProvider: GraphProvider;
  private readonly onDisposeEmitter = new vscode.EventEmitter<void>();
  public readonly onDispose = this.onDisposeEmitter.event;
  private readonly onDidChangeViewStateEmitter = new vscode.EventEmitter<vscode.WebviewPanelOnDidChangeViewStateEvent>();
  public readonly onDidChangeViewState = this.onDidChangeViewStateEmitter.event;


  constructor(webview: vscode.WebviewPanel, input: PipelinePreviewInput) {
    super();
    this.editor = webview;
    this.document = input.document;
    this.graphProvider = input.graphProvider;
    this.register(this.editor.onDidDispose(() => {
      this.dispose();
    }));

    this.register(vscode.workspace.onDidChangeTextDocument(e => {
      if (e.document.fileName === this.document.uri.fsPath) {
        this.update(e.document);
      }
    }));

    this.register(this.editor.webview.onDidReceiveMessage(e => {
      switch (e.type) {
        case 'onDidClick':
          this.onDidClick(e.body);
          break;
        case 'getSteps': 
          this.handleGetSteps(e.body);
          break;
        case 'showTaskLog':
          this.handleShowTaskLog(e.body);
          break;
        default:
          console.error(`Cannot handle message: ${e.type}`);
      }
    }));

    this.register(vscode.window.onDidChangeTextEditorSelection(e => {
      if (e.textEditor.document.fileName === this.document.uri.fsPath) {
        this.highlightNode(e.textEditor.document, e.selections);
      }
    }));

    if (input.pipelineRunName && (input.pipelineRunStatus === 'Started' || input.pipelineRunStatus === 'Unknown')) {
      const watchControl = kubectl.watchPipelineRunWithControl(input.pipelineRunName, run => {
        this.updatePipelineRun(run);
      });
      this.register({
        dispose: () => {
          if (!watchControl.terminated) {
            watchControl.kill();
          }
        }
      });
      watchControl.waitFinish().catch(err => {
        console.error(err);
      });
    }
    this.updateFunc();
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }

    this.onDisposeEmitter.fire();
    this.onDisposeEmitter.dispose();

    this.editor.dispose();
    super.dispose();
  }

  reveal(viewColumn: vscode.ViewColumn): void {
    this.editor.reveal(viewColumn);
  }

  update(document: vscode.TextDocument): void {
    if (this.document.uri.fsPath === document.fileName) {
      this.updateFunc();
    }
  }

  private async highlightNode(document: vscode.TextDocument, selections: ReadonlyArray<vscode.Selection>): Promise<void> {
    if (this.graphProvider.getElementBySelection && selections.length > 0) {
      const nodeId = this.graphProvider.getElementBySelection(document, selections[0]);
      if (nodeId) {
        this.postMessage({ type: 'highlightNode', data: nodeId });
      } else {
        this.postMessage({ type: 'removeHighlight' });
      }
    }
  }

  private async onDidClick(node: NodeData): Promise<void> {
    if ((this.document as vscode.TextDocument).positionAt) {
      const position = (this.document as vscode.TextDocument).positionAt(node.yamlPosition);
      for (const visibleEditor of vscode.window.visibleTextEditors) {
        if (this.isPreviewOf(visibleEditor.document.uri)) {
          const editor = await vscode.window.showTextDocument(visibleEditor.document, visibleEditor.viewColumn);
          editor.selection = new vscode.Selection(position, position);
          editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
          return;
        }
      }

      vscode.workspace.openTextDocument(this.document.uri)
        .then(vscode.window.showTextDocument)
        .then(undefined, () => {
          vscode.window.showErrorMessage(`Could not open ${this.document.uri.toString()}`);
        });
    }

  }

  private async handleGetSteps(node: NodeData): Promise<void> {
    try {
      const steps = await this.graphProvider.getTaskSteps(this.document, node);
      this.postMessage({type: 'showSteps', data: steps});
    } catch (err) {
      console.error(err);
      telemetryLogError('Pipeline Diagram', err);
    }
  
  }

  private handleShowTaskLog(taskRunName: string): void {
    TaskRun.showLogs(taskRunName);
  }

  private isPreviewOf(resource: vscode.Uri): boolean {
    return this.document.uri.fsPath === resource.fsPath;
  }

  private async doUpdate(): Promise<void> {
    if (this.disposed) {
      return;
    }
    const html = this.getHmlContent();
    this.setContent(html);

    try {
      const graph = await this.graphProvider.getGraph(this.document);
      this.postMessage({ type: 'showData', data: graph });
    } catch (err) {
      console.error(err);
    }
  }

  private async updatePipelineRun(run: PipelineRunData): Promise<void> {
    try {
      const graph = await this.graphProvider.getGraph(this.document, run);
      this.postMessage({ type: 'showData', data: graph });
    } catch (err) {
      console.error(err);
    }
  }

  private postMessage(msg: {}): void {
    if (!this.disposed) {
      this.editor.webview.postMessage(msg);
    }
  }

  private setContent(html: string): void {
    const fileName = path.basename(this.document.uri.fsPath);
    this.editor.title = `Preview ${fileName}`;
    this.editor.webview.options = getWebviewOptions();
    this.editor.webview.html = html;
  }

  private getHmlContent(): string {
    const nonce = new Date().getTime() + '' + new Date().getMilliseconds();
    const rule = this.editor.webview.cspSource;
    return `<!DOCTYPE html>
			<html>
			<head>
				<meta http-equiv="Content-type" content="text/html;charset=UTF-8">
                <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src 'self' ${rule} http: https: data:; media-src 'self' ${rule} http: https: data:; script-src 'nonce-${nonce}'; style-src 'self' ${rule} 'unsafe-inline' http: https: data:; font-src 'self' ${rule} http: https: data:;">
                <style>
                    html {
                        height: 100%; 
                        width: 100%;
                    }
                    #cy {
                        height: 100%; 
                        width: 100%;
                    }

                    #container {
                        width: 100vw; 
                        height: 100vh; 
                        display: flex; 
                        justify-content: center; 
                        align-items: center; 
                        padding: 0;
                        overflow: auto;
                    }
                </style>
			</head>
            <body id="container">
                <div id="cy" />
				${this.getScripts(nonce)}
			</body>
			</html>`;
  }

  private getScripts(nonce: string): string {
    const out: string[] = [];
    out.push(`<script async
				src="${escapeAttribute(this.editor.webview.asWebviewUri(vscode.Uri.file(path.join(contextGlobalState.extensionPath, '/out/webview/pipeline-preview/index.js'))))}"
				nonce="${nonce}"
				charset="UTF-8"></script>`);
    return out.join('\n');
  }

}

function escapeAttribute(value: string | vscode.Uri): string {
  return value.toString().replace(/"/g, '&quot;');
}


function getWebviewOptions(): vscode.WebviewOptions {
  return {
    enableScripts: true,
    localResourceRoots: getLocalResourceRoots()
  };
}

function getLocalResourceRoots(): vscode.Uri[] {
  return [
    vscode.Uri.file(path.join(contextGlobalState.extensionPath, '/out/webview/pipeline-preview')),
    vscode.Uri.file(path.join(contextGlobalState.extensionPath, '/images'))
  ];
}
