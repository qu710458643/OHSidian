/*
 * Copyright (c) 2023-2025 Haitai FangYuan Co., Ltd.
 * Redistribution and use in source and binary forms, with or without modification,
 * are permitted provided that the following conditions are met:
 *
 * 1. Redistributions of source code must retain the above copyright notice, this list of
 *    conditions and the following disclaimer.
 *
 * 2. Redistributions in binary form must reproduce the above copyright notice, this list
 *    of conditions and the following disclaimer in the documentation and/or other materials
 *    provided with the distribution.
 *
 * 3. Neither the name of the copyright holder nor the names of its contributors may be used
 *    to endorse or promote products derived from this software without specific prior written
 *    permission.
 *
 * THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS
 * "AS IS" AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO,
 * THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR
 * PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR
 * CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL,
 * EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO,
 * PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR PROFITS;
 * OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY,
 * WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR
 * OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF
 * ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
 */

import { injectable, inject } from 'inversify';
import font from '@ohos.font';
import { window } from '@kit.ArkUI';
import LogUtil from '../utils/LogUtil';

import { BaseAdapter } from '../common/BaseAdapter';
import LogMethod from '../common/LogDecorator';
import { ContextAdapter } from './ContextAdapter';

const TAG: string = 'FontAdapter';

@injectable()
export class FontAdapter extends BaseAdapter {
  private fontList: Array<string> = new Array<string>();
  private configFontList: Array<string> = new Array<string>();
  private fontInfo: font.FontInfo | undefined = undefined;
  private ctxAdapter: ContextAdapter;

  constructor(@inject(ContextAdapter) ctxAdapter: ContextAdapter) {
    super();
    this.ctxAdapter = ctxAdapter;
  }

  private getActiveWindow(): window.Window | undefined {
    return this.ctxAdapter.getActiveProxy().getWindow();
  }

  /** @throws BusinessError */
  @LogMethod
  getSystemFontList(): Array<string> {
    const activeWindow = this.getActiveWindow();
    if (!activeWindow) {
      LogUtil.warn(TAG, 'getSystemFontList skipped: no active window');
      return [];
    }
    this.fontList = activeWindow.getUIContext().getFont().getSystemFontList();
    return this.fontList;
  }

  @LogMethod
  getConfigFontList(): Array<string> {
    this.configFontList.splice(0);
    let fontConfig = font.getUIFontConfig();
    for (let i = 0; i < fontConfig.generic.length; i ++){
      for (let j = 0; j < fontConfig.generic[i].alias.length; j ++){
        this.configFontList.push(fontConfig.generic[i].alias[j].name);
      }
    }
    for (let i = 0; i < fontConfig.fallbackGroups.length; i ++){
      for (let j = 0; j < fontConfig.fallbackGroups[i].fallback.length; j ++){
        this.configFontList.push(fontConfig.fallbackGroups[i].fallback[j].family);
      }
    }
    return this.configFontList;
  }

  /** @throws BusinessError */
  @LogMethod
  getFontInfo(name: string): string {
    const activeWindow = this.getActiveWindow();
    if (!activeWindow) {
      LogUtil.warn(TAG, `getFontInfo skipped: no active window, name: ${name}`);
      return "";
    }
    this.fontInfo = activeWindow.getUIContext().getFont().getFontByName(name);
    if (this.fontInfo === undefined) {
      LogUtil.warn(TAG, `FontAdapter.GetFontInfo undefined, name: ${name} not found!`);
      return "";
    }
    return JSON.stringify(this.fontInfo);
  }
}
