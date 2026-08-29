/**
 * 模块功能: auto-review 图形配置界面——深色主题设置窗口（与审查对话框同风格）
 * 作者: hh-zyb
 * 创建日期: 2026年08月29日
 * 描述: 覆盖常用配置：总开关 / 审查对话框开关 / 审查工具 / provider 与模型 /
 *       超时与缓存 / 危险规则（添加/删除/测试/恢复出厂）；保存直接写数据目录
 *       JSON（settings.js 加载侧有类型校验与回落，写侧容错）；
 *       由 ctl.js 的 gui 子命令拉起（/auto-review gui）
 * 功能:
 *   - launchSettingsGui: 阻塞式弹出设置窗口，关闭后返回
 * 依赖: node:child_process node:fs node:path ./dialog.js(主题) ./common.js(路径)
 * 更新日期: 2026年08月29日
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { THEME } from "./dialog.js";
import {
  SETTINGS_FILE,
  DANGER_RULES_FILE,
  DEFAULT_SETTINGS_FILE,
  DEFAULT_DANGER_RULES_FILE,
} from "./common.js";

// 设置窗口的等待上限：用户可能长时间开着慢慢调，给足但不无限
const GUI_HARD_LIMIT_MS = 6 * 3600 * 1000;

// ZCode 配置文件候选（与 provider.js 的解析顺序一致）
function zcodeConfigCandidates() {
  if (process.env.AUTO_REVIEW_ZCODE_CONFIG) {
    return [path.resolve(process.env.AUTO_REVIEW_ZCODE_CONFIG)];
  }
  return [
    path.join(os.homedir(), ".zcode", "v2", "config.json"),
    path.join(os.homedir(), ".zcode", "cli", "config.json"),
  ];
}

// 设置窗口 PowerShell 脚本：深色主题、固定窗口、绝对定位；与审查对话框共用配色
const GUI_PS_SCRIPT = [
  "$ErrorActionPreference='Stop'",
  "Add-Type -AssemblyName System.Windows.Forms",
  "Add-Type -AssemblyName System.Drawing",
  "try { Add-Type 'using System;using System.Runtime.InteropServices;public class ARDwm{[DllImport(\"dwmapi.dll\")]public static extern int DwmSetWindowAttribute(IntPtr h,int a,ref int v,int s);}' } catch {}",
  "try { Add-Type -AssemblyName Microsoft.VisualBasic } catch {}",
  "$NL=[char]10",
  "function C($hex){ [System.Drawing.ColorTranslator]::FromHtml($hex) }",
  "function Lbl($text,$hex,$size,$style){ $l=New-Object System.Windows.Forms.Label; $l.Text=$text; $l.ForeColor=C $hex; $l.Font=New-Object System.Drawing.Font('Microsoft YaHei UI',$size,$style); $l.AutoSize=$true; return $l }",
  "function Box($text,$hex){ $p=New-Object System.Windows.Forms.GroupBox; $p.Text=$text; $p.ForeColor=C $hex; $p.BackColor=C '" + THEME.bg + "'; $p.FlatStyle='Flat'; $p.Font=New-Object System.Drawing.Font('Microsoft YaHei UI',9,[System.Drawing.FontStyle]::Bold); return $p }",
  "function Btn($text,$bg,$fg){ $b=New-Object System.Windows.Forms.Button; $b.Text=$text; $b.FlatStyle='Flat'; $b.FlatAppearance.BorderSize=0; $b.BackColor=C $bg; $b.ForeColor=C $fg; $b.Cursor='Hand'; $b.Font=New-Object System.Drawing.Font('Microsoft YaHei UI',9,[System.Drawing.FontStyle]::Bold); return $b }",
  // ── 数据加载 ──
  "$settingsPath=$env:AR_SETTINGS_FILE; $rulesPath=$env:AR_RULES_FILE",
  "$settings=Get-Content ($env:AR_DEFAULT_SETTINGS) -Raw -Encoding UTF8 | ConvertFrom-Json",
  "if(Test-Path $settingsPath){ try{ $settings=Get-Content $settingsPath -Raw -Encoding UTF8 | ConvertFrom-Json }catch{} }",
  "$rules=@()",
  "if(Test-Path $rulesPath){ try{ $rules=@(Get-Content $rulesPath -Raw -Encoding UTF8 | ConvertFrom-Json) }catch{} }",
  "if($rules.Count -eq 0){ $rules=@(Get-Content ($env:AR_DEFAULT_RULES) -Raw -Encoding UTF8 | ConvertFrom-Json) }",
  "$provTable=$null; $provKeys=@()",
  "if(Test-Path $env:AR_ZCODE_CFG){ try{ $zc=Get-Content $env:AR_ZCODE_CFG -Raw -Encoding UTF8 | ConvertFrom-Json; if($zc.provider){ $provTable=$zc.provider; $provKeys=@($zc.provider.PSObject.Properties.Name) } }catch{} }",
  // ── 窗体 ──
  "$f=New-Object System.Windows.Forms.Form",
  "$f.Text='auto-review 设置'",
  "$f.BackColor=C '" + THEME.bg + "'",
  "$f.StartPosition='CenterScreen'; $f.FormBorderStyle='FixedDialog'; $f.MaximizeBox=$false",
  "$f.Size=New-Object System.Drawing.Size(740,700); $f.Font=New-Object System.Drawing.Font('Microsoft YaHei UI',9.75)",
  "$title=Lbl 'auto-review 设置' '" + THEME.text + "' 14 ([System.Drawing.FontStyle]::Bold)",
  "$title.Location=New-Object System.Drawing.Point(22,16)",
  // ── 开关区 ──
  "$gSw=Box '开关' '" + THEME.accent + "'",
  "$gSw.Location=New-Object System.Drawing.Point(20,56); $gSw.Size=New-Object System.Drawing.Size(684,78)",
  "$ckEnabled=New-Object System.Windows.Forms.CheckBox",
  "$ckEnabled.Text='启用自动审查（关闭后 hook 不再干预任何工具调用）'",
  "$ckEnabled.ForeColor=C '" + THEME.text + "'; $ckEnabled.BackColor=C '" + THEME.bg + "'",
  "$ckEnabled.AutoSize=$true; $ckEnabled.Location=New-Object System.Drawing.Point(14,26)",
  "$ckEnabled.Checked=($settings.enabled -eq $true)",
  "$ckDialog=New-Object System.Windows.Forms.CheckBox",
  "$ckDialog.Text='ask 决策弹出插件审查对话框（默认关闭：审批走客户端原生流程，原生框不显示审查分析）'",
  "$ckDialog.ForeColor=C '" + THEME.text + "'; $ckDialog.BackColor=C '" + THEME.bg + "'",
  "$ckDialog.AutoSize=$true; $ckDialog.Location=New-Object System.Drawing.Point(14,50)",
  "$ckDialog.Checked=($settings.dialog_on_ask -eq $true)",
  "$gSw.Controls.AddRange(@($ckEnabled,$ckDialog))",
  // ── 审查范围区 ──
  "$gTools=Box '审查范围' '" + THEME.accent + "'",
  "$gTools.Location=New-Object System.Drawing.Point(20,142); $gTools.Size=New-Object System.Drawing.Size(684,66)",
  "$toolChecks=@{}",
  "$tx=14",
  "foreach($tn in @('Bash','Write','Edit')){",
  "  $c=New-Object System.Windows.Forms.CheckBox",
  "  $c.Text=$tn; $c.ForeColor=C '" + THEME.text + "'; $c.BackColor=C '" + THEME.bg + "'; $c.AutoSize=$true",
  "  $c.Location=New-Object System.Drawing.Point($tx,28)",
  "  $c.Checked=($settings.review_tools -contains $tn)",
  "  $gTools.Controls.Add($c); $toolChecks[$tn]=$c; $tx+=110",
  "}",
  // ── 模型区 ──
  "$gModel=Box '安全子 agent 模型' '" + THEME.accent + "'",
  "$gModel.Location=New-Object System.Drawing.Point(20,216); $gModel.Size=New-Object System.Drawing.Size(684,90)",
  "$l1=Lbl 'Provider' '" + THEME.text + "' 9 ([System.Drawing.FontStyle]::Regular); $l1.Location=New-Object System.Drawing.Point(14,30)",
  "$cbProv=New-Object System.Windows.Forms.ComboBox",
  "$cbProv.DropDownStyle='DropDownList'; $cbProv.BackColor=C '" + THEME.panel + "'; $cbProv.ForeColor=C '" + THEME.text + "'",
  "$cbProv.Location=New-Object System.Drawing.Point(90,26); $cbProv.Size=New-Object System.Drawing.Size(240,26)",
  "[void]$cbProv.Items.Add('（跟随主 agent）')",
  "$provKeyMap=@{}",
  "foreach($k in $provKeys){ $dn=$k -replace '^builtin:',''; [void]$cbProv.Items.Add($dn); $provKeyMap[$dn]=$k }",
  "$curProv=[string]$settings.provider",
  "if(-not $curProv){ $cbProv.SelectedIndex=0 } else { $dn=$curProv -replace '^builtin:',''; if($cbProv.Items.Contains($dn)){ $cbProv.SelectedItem=$dn } else { $cbProv.SelectedIndex=0 } }",
  "$l2=Lbl '模型' '" + THEME.text + "' 9 ([System.Drawing.FontStyle]::Regular); $l2.Location=New-Object System.Drawing.Point(360,30)",
  "$cbModel=New-Object System.Windows.Forms.ComboBox",
  "$cbModel.DropDownStyle='DropDownList'; $cbModel.BackColor=C '" + THEME.panel + "'; $cbModel.ForeColor=C '" + THEME.text + "'",
  "$cbModel.Location=New-Object System.Drawing.Point(400,26); $cbModel.Size=New-Object System.Drawing.Size(250,26)",
  "function Fill-Models{",
  "  $cbModel.Items.Clear(); [void]$cbModel.Items.Add('（默认）')",
  "  if($provTable -and $cbProv.SelectedIndex -gt 0){",
  "    $key=$provKeyMap[[string]$cbProv.SelectedItem]",
  "    if($provTable.$key -and $provTable.$key.models){ foreach($m in @($provTable.$key.models.PSObject.Properties.Name)){ [void]$cbModel.Items.Add($m) } }",
  "  }",
  "  $curModel=[string]$settings.model",
  "  if($curModel -and $cbModel.Items.Contains($curModel)){ $cbModel.SelectedItem=$curModel } else { $cbModel.SelectedIndex=0 }",
  "}",
  "Fill-Models",
  "$cbProv.Add_SelectedIndexChanged({ Fill-Models })",
  "$l3=Lbl '超时(ms)' '" + THEME.text + "' 9 ([System.Drawing.FontStyle]::Regular); $l3.Location=New-Object System.Drawing.Point(14,62)",
  "$txTimeout=New-Object System.Windows.Forms.TextBox",
  "$txTimeout.BackColor=C '" + THEME.panel + "'; $txTimeout.ForeColor=C '" + THEME.text + "'; $txTimeout.BorderStyle='FixedSingle'",
  "$txTimeout.Location=New-Object System.Drawing.Point(90,58); $txTimeout.Size=New-Object System.Drawing.Size(100,24)",
  "$txTimeout.Text=[string]$settings.timeout_ms",
  "$l4=Lbl '缓存(秒)' '" + THEME.text + "' 9 ([System.Drawing.FontStyle]::Regular); $l4.Location=New-Object System.Drawing.Point(220,62)",
  "$txCache=New-Object System.Windows.Forms.TextBox",
  "$txCache.BackColor=C '" + THEME.panel + "'; $txCache.ForeColor=C '" + THEME.text + "'; $txCache.BorderStyle='FixedSingle'",
  "$txCache.Location=New-Object System.Drawing.Point(290,58); $txCache.Size=New-Object System.Drawing.Size(100,24)",
  "$txCache.Text=[string]$settings.cache_ttl_seconds",
  "$gModel.Controls.AddRange(@($l1,$cbProv,$l2,$cbModel,$l3,$txTimeout,$l4,$txCache))",
  // ── 危险规则区 ──
  "$gRules=Box '危险规则（优先于安全子 agent，不经过 LLM）' '" + THEME.accent + "'",
  "$gRules.Location=New-Object System.Drawing.Point(20,314); $gRules.Size=New-Object System.Drawing.Size(684,268)",
  "$lbRules=New-Object System.Windows.Forms.ListBox",
  "$lbRules.BackColor=C '" + THEME.panel + "'; $lbRules.ForeColor=C '" + THEME.text + "'; $lbRules.BorderStyle='FixedSingle'",
  "$lbRules.Location=New-Object System.Drawing.Point(14,28); $lbRules.Size=New-Object System.Drawing.Size(470,200)",
  "$lbRules.Font=New-Object System.Drawing.Font('Consolas',9)",
  "function Refresh-Rules{",
  "  $lbRules.Items.Clear()",
  "  $i=1",
  "  foreach($r in $rules){ [void]$lbRules.Items.Add(('#'+$i+' ['+$r.action+'] '+$r.description+'  —  '+$r.pattern)); $i++ }",
  "}",
  "Refresh-Rules",
  "$bAdd=Btn '添加规则' '" + THEME.accent + "' '#FFFFFF'; $bAdd.Size=New-Object System.Drawing.Size(96,34); $bAdd.Location=New-Object System.Drawing.Point(500,28)",
  "$bDel=Btn '删除所选' '" + THEME.denyBg + "' '" + THEME.riskHigh + "'; $bDel.Size=New-Object System.Drawing.Size(96,34); $bDel.Location=New-Object System.Drawing.Point(500,70)",
  "$bTest=Btn '测试命中' '" + THEME.panel + "' '" + THEME.accent + "'; $bTest.Size=New-Object System.Drawing.Size(96,34); $bTest.Location=New-Object System.Drawing.Point(500,112)",
  "$bReset=Btn '恢复出厂' '" + THEME.panel + "' '" + THEME.textDim + "'; $bReset.Size=New-Object System.Drawing.Size(96,34); $bReset.Location=New-Object System.Drawing.Point(500,154)",
  "$rulesHint=Lbl '动作：deny=拦截 ask=转人工 allow=白名单；正则大小写不敏感' '" + THEME.textDim + "' 8.25 ([System.Drawing.FontStyle]::Regular)",
  "$rulesHint.Location=New-Object System.Drawing.Point(14,234)",
  "$gRules.Controls.AddRange(@($lbRules,$bAdd,$bDel,$bTest,$bReset,$rulesHint))",
  // ── 规则操作逻辑 ──
  "$bAdd.Add_Click({",
  "  $sf=New-Object System.Windows.Forms.Form",
  "  $sf.Text='添加危险规则'; $sf.BackColor=C '" + THEME.bg + "'; $sf.FormBorderStyle='FixedDialog'; $sf.StartPosition='CenterParent'",
  "  $sf.Size=New-Object System.Drawing.Size(520,240)",
  "  $sa=New-Object System.Windows.Forms.ComboBox; $sa.DropDownStyle='DropDownList'",
  "  $sa.Items.AddRange(@('deny','ask','allow')); $sa.SelectedIndex=0",
  "  $sa.BackColor=C '" + THEME.panel + "'; $sa.ForeColor=C '" + THEME.text + "'",
  "  $sa.Location=New-Object System.Drawing.Point(90,20); $sa.Size=New-Object System.Drawing.Size(120,26)",
  "  $la=Lbl '动作' '" + THEME.text + "' 9 ([System.Drawing.FontStyle]::Regular); $la.Location=New-Object System.Drawing.Point(20,24)",
  "  $sp=New-Object System.Windows.Forms.TextBox",
  "  $sp.BackColor=C '" + THEME.panel + "'; $sp.ForeColor=C '" + THEME.text + "'; $sp.BorderStyle='FixedSingle'",
  "  $sp.Font=New-Object System.Drawing.Font('Consolas',9)",
  "  $sp.Location=New-Object System.Drawing.Point(90,56); $sp.Size=New-Object System.Drawing.Size(400,24)",
  "  $lp=Lbl '正则' '" + THEME.text + "' 9 ([System.Drawing.FontStyle]::Regular); $lp.Location=New-Object System.Drawing.Point(20,60)",
  "  $sd=New-Object System.Windows.Forms.TextBox",
  "  $sd.BackColor=C '" + THEME.panel + "'; $sd.ForeColor=C '" + THEME.text + "'; $sd.BorderStyle='FixedSingle'",
  "  $sd.Location=New-Object System.Drawing.Point(90,92); $sd.Size=New-Object System.Drawing.Size(400,24)",
  "  $ld=Lbl '描述' '" + THEME.text + "' 9 ([System.Drawing.FontStyle]::Regular); $ld.Location=New-Object System.Drawing.Point(20,96)",
  "  $ok=Btn '确定' '" + THEME.accent + "' '#FFFFFF'; $ok.Size=New-Object System.Drawing.Size(96,34); $ok.Location=New-Object System.Drawing.Point(300,140)",
  "  $no=Btn '取消' '" + THEME.panel + "' '" + THEME.textDim + "'; $no.Size=New-Object System.Drawing.Size(96,34); $no.Location=New-Object System.Drawing.Point(404,140)",
  "  $sf.Controls.AddRange(@($la,$sa,$lp,$sp,$ld,$sd,$ok,$no))",
  "  $script:added=$false",
  "  $ok.Add_Click({",
  "    if(-not $sp.Text.Trim()){ [System.Windows.Forms.MessageBox]::Show('正则不能为空','auto-review'); return }",
  "    try{ [regex]::new($sp.Text,'IgnoreCase,Multiline') | Out-Null }catch{ [System.Windows.Forms.MessageBox]::Show('正则编译失败: '+$_.Exception.Message,'auto-review'); return }",
  "    $script:added=$true; $sf.Close()",
  "  })",
  "  $no.Add_Click({ $sf.Close() })",
  "  [void]$sf.ShowDialog($f)",
  "  if($script:added){",
  "    $nr=New-Object PSObject -Property @{ pattern=$sp.Text; action=$sa.SelectedItem; description=$sd.Text }",
  "    $rules=@($rules + $nr); Refresh-Rules",
  "  }",
  "})",
  "$bDel.Add_Click({",
  "  if($lbRules.SelectedIndex -lt 0){ [System.Windows.Forms.MessageBox]::Show('先选中一条规则','auto-review'); return }",
  "  $idx=$lbRules.SelectedIndex",
  "  if([System.Windows.Forms.MessageBox]::Show('确定删除规则 '+($idx+1)+' ？','auto-review','YesNo') -eq 'Yes'){",
  "    $list=New-Object System.Collections.ArrayList",
  "  foreach($r in $rules){ [void]$list.Add($r) }",
  "    $list.RemoveAt($idx); $rules=@($list); Refresh-Rules",
  "  }",
  "})",
  "$bTest.Add_Click({",
  "  $cmd=[Microsoft.VisualBasic.Interaction]::InputBox('输入要测试的命令文本','规则命中测试','')",
  "  if($cmd){",
  "    $hits=@(); $i=1",
  "    foreach($r in $rules){ try{ if(([regex]::new($r.pattern,'IgnoreCase,Multiline')).IsMatch($cmd)){ $hits+=('#'+$i+' ['+$r.action+'] '+$r.description) } }catch{}; $i++ }",
  "    $msg= if($hits.Count){ '命中 '+$hits.Count+' 条:'+$NL+($hits -join $NL) } else { '未命中任何规则（将进入安全子 agent 审查）' }",
  "    [System.Windows.Forms.MessageBox]::Show($msg,'规则命中测试')",
  "  }",
  "})",
  "$bReset.Add_Click({",
  "  if([System.Windows.Forms.MessageBox]::Show('恢复出厂规则？当前规则表将被覆盖（自定义规则请先备份）','auto-review','YesNo') -eq 'Yes'){",
  "    $rules=@(Get-Content ($env:AR_DEFAULT_RULES) -Raw -Encoding UTF8 | ConvertFrom-Json); Refresh-Rules",
  "  }",
  "})",
  // ── 底部：保存/关闭 ──
  "$sep=New-Object System.Windows.Forms.Label",
  "$sep.AutoSize=$false; $sep.Size=New-Object System.Drawing.Size(692,1); $sep.Location=New-Object System.Drawing.Point(20,596)",
  "$sep.BackColor=C '" + THEME.border + "'",
  "$saved=Lbl '' '" + THEME.textDim + "' 8.25 ([System.Drawing.FontStyle]::Regular)",
  "$saved.Location=New-Object System.Drawing.Point(22,616); $saved.AutoSize=$true",
  "$bClose=Btn '关 闭' '" + THEME.panel + "' '" + THEME.textDim + "'",
  "$bClose.Size=New-Object System.Drawing.Size(110,38); $bClose.Location=New-Object System.Drawing.Point(478,606)",
  "$bSave=Btn '保 存' '" + THEME.accent + "' '#FFFFFF'",
  "$bSave.Size=New-Object System.Drawing.Size(110,38); $bSave.Location=New-Object System.Drawing.Point(598,606)",
  "$bSave.Add_Click({",
  "  try{",
  "    $tools=@(); foreach($tn in @('Bash','Write','Edit')){ if($toolChecks[$tn].Checked){ $tools+=$tn } }",
  "    $provVal=''; if($cbProv.SelectedIndex -gt 0){ $provVal=$provKeyMap[[string]$cbProv.SelectedItem] }",
  "    $modelVal=''; if($cbModel.SelectedIndex -gt 0){ $modelVal=[string]$cbModel.SelectedItem }",
  "    $to=0; [int]::TryParse($txTimeout.Text,[ref]$to) | Out-Null; if($to -lt 5000){$to=5000}; if($to -gt 45000){$to=45000}",
  "    $ca=0; [int]::TryParse($txCache.Text,[ref]$ca) | Out-Null; if($ca -lt 0){$ca=0}",
  "    $o=[ordered]@{ enabled=$ckEnabled.Checked; review_tools=$tools; provider=$provVal; model=$modelVal; timeout_ms=$to; cache_ttl_seconds=$ca; max_payload_chars=[int]$settings.max_payload_chars; dialog_on_ask=$ckDialog.Checked }",
  "    (New-Object PSObject -Property $o) | ConvertTo-Json | Set-Content -LiteralPath $settingsPath -Encoding UTF8",
  "    $rj= if($rules.Count -eq 1){ '['+($rules | ConvertTo-Json -Compress)+']' } else { ($rules | ConvertTo-Json -Depth 5) }",
  "    Set-Content -LiteralPath $rulesPath -Value $rj -Encoding UTF8",
  "    $saved.Text='已保存 '+(Get-Date -Format 'HH:mm:ss')",
  "  } catch { [System.Windows.Forms.MessageBox]::Show('保存失败: '+$_.Exception.Message,'auto-review') }",
  "})",
  "$bClose.Add_Click({ $f.Close() })",
  "$f.Controls.AddRange(@($title,$gSw,$gTools,$gModel,$gRules,$sep,$saved,$bClose,$bSave))",
  "$f.Add_Shown({ try{ $dark=1; [ARDwm]::DwmSetWindowAttribute($f.Handle,20,[ref]$dark,4) } catch {} })",
  "[void]$f.ShowDialog()",
].join("\n");

/**
 * 函数功能: 拉起图形配置窗口并阻塞至关闭
 * @returns {boolean} 是否成功启动（非 Windows / 启动失败返回 false）
 */function launchSettingsGui() {
  if (process.platform !== "win32") {
    return false;
  }
  const t_candidates = zcodeConfigCandidates();
  const t_zcode_cfg = t_candidates.find((t_p) => fs.existsSync(t_p)) || t_candidates[0];
  try {
    const t_result = spawnSync(
      "powershell",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", GUI_PS_SCRIPT],
      {
        env: {
          ...process.env,
          AR_SETTINGS_FILE: SETTINGS_FILE(),
          AR_RULES_FILE: DANGER_RULES_FILE(),
          AR_DEFAULT_SETTINGS: DEFAULT_SETTINGS_FILE,
          AR_DEFAULT_RULES: DEFAULT_DANGER_RULES_FILE,
          AR_ZCODE_CFG: t_zcode_cfg,
        },
        timeout: GUI_HARD_LIMIT_MS,
        windowsHide: true,
      },
    );
    return t_result.status === 0 || t_result.status === null;
  } catch {
    return false;
  }
}

export {
  launchSettingsGui,
  GUI_PS_SCRIPT,
};
