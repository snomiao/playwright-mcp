/**
 * Copyright (c) Microsoft Corporation.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

export function debugLog(...args: unknown[]): void {
  const enabled = true;
  if (enabled) {
    // eslint-disable-next-line no-console
    console.log('[Extension]', ...args);
  }
}

type ProtocolCommand = {
  id: number;
  method: string;
  params?: any;
};

type ProtocolResponse = {
  id?: number;
  method?: string;
  params?: any;
  result?: any;
  error?: string;
};

export class RelayConnection {
  private _debuggee: chrome.debugger.Debuggee;
  private _ws: WebSocket;
  private _eventListener: (source: chrome.debugger.DebuggerSession, method: string, params: any) => void;
  private _detachListener: (source: chrome.debugger.Debuggee, reason: string) => void;
  private _tabPromise: Promise<void>;
  private _tabPromiseResolve!: () => void;
  private _closed = false;
  private _multiTabMode = false;
  private _allTabIds: Set<number> = new Set();

  onclose?: () => void;

  constructor(ws: WebSocket) {
    this._debuggee = { };
    this._tabPromise = new Promise(resolve => this._tabPromiseResolve = resolve);
    this._ws = ws;
    this._ws.onmessage = this._onMessage.bind(this);
    this._ws.onclose = () => this._onClose();
    // Store listeners for cleanup
    this._eventListener = this._onDebuggerEvent.bind(this);
    this._detachListener = this._onDebuggerDetach.bind(this);
    chrome.debugger.onEvent.addListener(this._eventListener);
    chrome.debugger.onDetach.addListener(this._detachListener);
  }

  // Either setTabId or close is called after creating the connection.
  setTabId(tabId: number): void {
    this._debuggee = { tabId };
    this._tabPromiseResolve();
  }

  close(message: string): void {
    this._ws.close(1000, message);
    // ws.onclose is called asynchronously, so we call it here to avoid forwarding
    // CDP events to the closed connection.
    this._onClose();
  }

  private _onClose() {
    if (this._closed)
      return;
    this._closed = true;
    chrome.debugger.onEvent.removeListener(this._eventListener);
    chrome.debugger.onDetach.removeListener(this._detachListener);
    chrome.debugger.detach(this._debuggee).catch(() => {});
    this.onclose?.();
  }

  private _onDebuggerEvent(source: chrome.debugger.DebuggerSession, method: string, params: any): void {
    if (this._multiTabMode) {
      if (!this._allTabIds.has(source.tabId!))
        return;
    } else {
      if (source.tabId !== this._debuggee.tabId)
        return;
    }
    debugLog('Forwarding CDP event:', method, params);
    const sessionId = source.sessionId;
    this._sendMessage({
      method: 'forwardCDPEvent',
      params: {
        sessionId,
        method,
        params,
        tabId: this._multiTabMode ? source.tabId : undefined,
      },
    });
  }

  private _onDebuggerDetach(source: chrome.debugger.Debuggee, reason: string): void {
    if (this._multiTabMode) {
      this._allTabIds.delete(source.tabId!);
      debugLog(`Tab ${source.tabId} detached: ${reason}. Remaining tabs: ${this._allTabIds.size}`);
      if (this._allTabIds.size === 0)
        this.close('All browser tabs closed');
      return;
    }
    if (source.tabId !== this._debuggee.tabId)
      return;
    this.close(`Debugger detached: ${reason}`);
    this._debuggee = { };
  }

  private _onMessage(event: MessageEvent): void {
    this._onMessageAsync(event).catch(e => debugLog('Error handling message:', e));
  }

  private async _onMessageAsync(event: MessageEvent): Promise<void> {
    let message: ProtocolCommand;
    try {
      message = JSON.parse(event.data);
    } catch (error: any) {
      debugLog('Error parsing message:', error);
      this._sendError(-32700, `Error parsing message: ${error.message}`);
      return;
    }

    debugLog('Received message:', message);

    const response: ProtocolResponse = {
      id: message.id,
    };
    try {
      response.result = await this._handleCommand(message);
    } catch (error: any) {
      debugLog('Error handling command:', error);
      response.error = error.message;
    }
    debugLog('Sending response:', response);
    this._sendMessage(response);
  }

  private async _handleCommand(message: ProtocolCommand): Promise<any> {
    if (message.method === 'attachToTab') {
      await this._tabPromise;
      debugLog('Attaching debugger to tab:', this._debuggee);
      await chrome.debugger.attach(this._debuggee, '1.3');
      const result: any = await chrome.debugger.sendCommand(this._debuggee, 'Target.getTargetInfo');
      return {
        targetInfo: result?.targetInfo,
      };
    }
    if (message.method === 'attachToAllTabs') {
      const allTabs = await chrome.tabs.query({});
      const regularTabs = allTabs.filter(tab =>
        tab.id !== undefined &&
        tab.url &&
        !['chrome:', 'edge:', 'devtools:', 'chrome-extension:'].some(scheme => tab.url!.startsWith(scheme))
      );
      const results = [];
      for (const tab of regularTabs) {
        const debuggee: chrome.debugger.Debuggee = { tabId: tab.id! };
        try {
          await chrome.debugger.attach(debuggee, '1.3');
          debugLog(`Attached debugger to tab ${tab.id}: ${tab.url}`);
        } catch (e: any) {
          debugLog(`Failed to attach to tab ${tab.id}: ${e.message}`);
          continue;
        }
        let targetInfo: any;
        try {
          const result: any = await chrome.debugger.sendCommand(debuggee, 'Target.getTargetInfo');
          targetInfo = result?.targetInfo;
        } catch {
          targetInfo = { tabId: tab.id, url: tab.url, title: tab.title, type: 'page', targetId: String(tab.id) };
        }
        this._allTabIds.add(tab.id!);
        results.push({ tabId: tab.id!, targetInfo });
      }
      this._multiTabMode = true;
      debugLog(`attachToAllTabs: attached to ${results.length} tabs`);
      return { tabs: results };
    }
    if (!this._debuggee.tabId && !this._multiTabMode)
      throw new Error('No tab is connected. Please go to the Playwright MCP extension and select the tab you want to connect to.');
    if (message.method === 'forwardCDPCommand') {
      const { sessionId, method, params, tabId } = message.params;
      debugLog('CDP command:', method, params);
      let debuggee: chrome.debugger.Debuggee;
      if (tabId !== undefined && this._allTabIds.has(tabId)) {
        debuggee = { tabId };
      } else if (this._debuggee.tabId) {
        debuggee = this._debuggee;
      } else {
        throw new Error(`No tab found for tabId: ${tabId}`);
      }
      const debuggerSession: chrome.debugger.DebuggerSession = {
        ...debuggee,
        sessionId,
      };
      // Forward CDP command to chrome.debugger
      return await chrome.debugger.sendCommand(
          debuggerSession,
          method,
          params
      );
    }
  }

  private _sendError(code: number, message: string): void {
    this._sendMessage({
      error: {
        code,
        message,
      },
    });
  }

  private _sendMessage(message: any): void {
    if (this._ws.readyState === WebSocket.OPEN)
      this._ws.send(JSON.stringify(message));
  }
}
