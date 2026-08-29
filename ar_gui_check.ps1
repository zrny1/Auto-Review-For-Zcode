$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
try { Add-Type 'using System;using System.Runtime.InteropServices;public class ARDwm{[DllImport("dwmapi.dll")]public static extern int DwmSetWindowAttribute(IntPtr h,int a,ref int v,int s);[DllImport("user32.dll")]public static extern bool ShowWindow(IntPtr h,int c);}' } catch {}
try { Add-Type -AssemblyName Microsoft.VisualBasic } catch {}
$NL=[char]10
function C($hex){ [System.Drawing.ColorTranslator]::FromHtml($hex) }
function Lbl($text,$hex,$size,$style){ $l=New-Object System.Windows.Forms.Label; $l.Text=$text; $l.ForeColor=C $hex; $l.Font=New-Object System.Drawing.Font('Microsoft YaHei UI',$size,$style); $l.AutoSize=$true; return $l }
function Sec($text){ Lbl $text '#4C8DFF' 9.75 ([System.Drawing.FontStyle]::Bold) }
function Round($ctrl,$r){
  $p=New-Object System.Drawing.Drawing2D.GraphicsPath
  $d=2*$r
  $p.AddArc(0,0,$d,$d,180,90); $p.AddArc($ctrl.Width-$d,0,$d,$d,270,90); $p.AddArc($ctrl.Width-$d,$ctrl.Height-$d,$d,$d,0,90); $p.AddArc(0,$ctrl.Height-$d,$d,$d,90,90)
  $p.CloseFigure()
  $ctrl.Region=New-Object System.Drawing.Region($p)
}
function Btn($text,$bg,$fg){ $b=New-Object System.Windows.Forms.Button; $b.Text=$text; $b.FlatStyle='Flat'; $b.FlatAppearance.BorderSize=0; $b.BackColor=C $bg; $b.ForeColor=C $fg; $b.Cursor='Hand'; $b.Font=New-Object System.Drawing.Font('Microsoft YaHei UI',9.75,[System.Drawing.FontStyle]::Bold); return $b }
function Apply-Check($st){
  $b=$st.row.Controls[0]; $m=$b.Controls[0]
  if($st.checked){ $b.BackColor=C '#4C8DFF' } else { $b.BackColor=C '#252526' }
  $m.Visible=$st.checked
}
function New-Check($text,$w,$initial){
  $row=New-Object System.Windows.Forms.Panel
  $row.Size=New-Object System.Drawing.Size($w,28); $row.BackColor=C '#1E1E1E'; $row.Cursor='Hand'
  $box=New-Object System.Windows.Forms.Panel
  $box.Size=New-Object System.Drawing.Size(20,20); $box.Location=New-Object System.Drawing.Point(0,4); $box.BackColor=C '#252526'
  Round $box 5
  $mark=New-Object System.Windows.Forms.Label
  $mark.Text=[char]10004; $mark.AutoSize=$false; $mark.Size=New-Object System.Drawing.Size(20,20); $mark.TextAlign='MiddleCenter'
  $mark.ForeColor=C '#FFFFFF'; $mark.BackColor='Transparent'; $mark.Font=New-Object System.Drawing.Font('Microsoft YaHei UI',9,[System.Drawing.FontStyle]::Bold)
  $box.Controls.Add($mark)
  $lbl=New-Object System.Windows.Forms.Label
  $lbl.Text=$text; $lbl.ForeColor=C '#D4D4D4'; $lbl.BackColor=C '#1E1E1E'; $lbl.Cursor='Hand'
  $lw=($w - 30)
  $lbl.AutoSize=$false; $lbl.Size=New-Object System.Drawing.Size($lw,24); $lbl.Location=New-Object System.Drawing.Point(30,4)
  $row.Controls.AddRange(@($box,$lbl))
  $state=@{checked=($initial -eq $true); row=$row}
  $row.Tag=$state; $box.Tag=$state; $lbl.Tag=$state
  $toggle={ $st=$this.Tag; $st.checked=(-not $st.checked); Apply-Check $st }
  $row.Add_Click($toggle); $box.Add_Click($toggle); $lbl.Add_Click($toggle)
  Apply-Check $state
  return $row
}
function Theme-Combo($cb){
  $cb.DrawMode='OwnerDrawFixed'; $cb.ItemHeight=22
  $cb.Add_DrawItem({
    param($s,$e)
    if($e.Index -lt 0 -or $e.Index -ge $s.Items.Count){ return }
    $sel=(($e.State -band [System.Windows.Forms.DrawItemState]::Selected) -ne 0)
    $bgHex= if($sel){ '#4C8DFF' } else { '#252526' }
    $fgHex= if($sel){ '#FFFFFF' } else { '#D4D4D4' }
    $br=New-Object System.Drawing.SolidBrush (C $bgHex)
    $e.Graphics.FillRectangle($br,$e.Bounds)
    $tf=New-Object System.Drawing.Font('Microsoft YaHei UI',9.75)
    $tb=New-Object System.Drawing.SolidBrush (C $fgHex)
    $e.Graphics.DrawString([string]$s.Items[$e.Index],$tf,$tb,($e.Bounds.X+8),($e.Bounds.Y+3))
    $br.Dispose(); $tb.Dispose(); $tf.Dispose()
  })
}
$settingsPath=$env:AR_SETTINGS_FILE; $rulesPath=$env:AR_RULES_FILE
$settings=Get-Content ($env:AR_DEFAULT_SETTINGS) -Raw -Encoding UTF8 | ConvertFrom-Json
if(Test-Path $settingsPath){ try{ $settings=Get-Content $settingsPath -Raw -Encoding UTF8 | ConvertFrom-Json }catch{} }
$rules=@()
if(Test-Path $rulesPath){ try{ $parsed=Get-Content $rulesPath -Raw -Encoding UTF8 | ConvertFrom-Json; $rules=@($parsed | Where-Object { $_ -and $_.pattern }) }catch{} }
if($rules.Count -eq 0){ $parsed=Get-Content ($env:AR_DEFAULT_RULES) -Raw -Encoding UTF8 | ConvertFrom-Json; $rules=@($parsed | Where-Object { $_ -and $_.pattern }) }
$provTable=$null; $provKeys=@()
if(Test-Path $env:AR_ZCODE_CFG){ try{ $zc=Get-Content $env:AR_ZCODE_CFG -Raw -Encoding UTF8 | ConvertFrom-Json; if($zc.provider){ $provTable=$zc.provider; $provKeys=@($zc.provider.PSObject.Properties.Name) } }catch{} }
$followProv=$null
if($provTable){ foreach($k in $provKeys){ if($provTable.$k -and $provTable.$k.enabled -eq $true){ $followProv=$k; break } } }
$f=New-Object System.Windows.Forms.Form
$f.Text='auto-review 设置'
$f.BackColor=C '#1E1E1E'
$f.StartPosition='CenterScreen'; $f.FormBorderStyle='FixedDialog'; $f.MaximizeBox=$false
$f.TopMost=$true
$f.Size=New-Object System.Drawing.Size(760,700); $f.Font=New-Object System.Drawing.Font('Microsoft YaHei UI',9.75)
$title=Lbl 'auto-review 设置' '#D4D4D4' 14 ([System.Drawing.FontStyle]::Bold)
$title.Location=New-Object System.Drawing.Point(26,16)
$s1=Sec '开关'; $s1.Location=New-Object System.Drawing.Point(26,56)
$ckEnabled=New-Check '启用自动审查（关闭后 hook 不再干预任何工具调用）' 640 ($settings.enabled -eq $true)
$ckEnabled.Location=New-Object System.Drawing.Point(26,82)
$ckDialog=New-Check 'ask 决策弹出插件审查对话框（默认关闭：审批走客户端原生流程，不显示分析）' 640 ($settings.dialog_on_ask -eq $true)
$ckDialog.Location=New-Object System.Drawing.Point(26,112)
$s2=Sec '审查范围'; $s2.Location=New-Object System.Drawing.Point(26,150)
$toolChecks=@{}
$tx=26
foreach($tn in @('Bash','Write','Edit')){
  $c=New-Check $tn 120 ($settings.review_tools -contains $tn)
  $c.Location=New-Object System.Drawing.Point($tx,178)
  $f.Controls.Add($c); $toolChecks[$tn]=$c; $tx+=150
}
$s3=Sec '安全子 agent 模型'; $s3.Location=New-Object System.Drawing.Point(26,214)
$l1=Lbl 'Provider' '#D4D4D4' 9 ([System.Drawing.FontStyle]::Regular); $l1.Location=New-Object System.Drawing.Point(26,246)
$cbProv=New-Object System.Windows.Forms.ComboBox
$cbProv.DropDownStyle='DropDownList'; $cbProv.BackColor=C '#252526'; $cbProv.ForeColor=C '#D4D4D4'; $cbProv.FlatStyle='Flat'
$cbProv.Location=New-Object System.Drawing.Point(110,242); $cbProv.Size=New-Object System.Drawing.Size(250,28)
[void]$cbProv.Items.Add('（跟随主 agent）')
$provKeyMap=@{}
foreach($k in $provKeys){ $dn=$k -replace '^builtin:',''; [void]$cbProv.Items.Add($dn); $provKeyMap[$dn]=$k }
$curProv=[string]$settings.provider
if(-not $curProv){ $cbProv.SelectedIndex=0 } else { $dn=$curProv -replace '^builtin:',''; if($cbProv.Items.Contains($dn)){ $cbProv.SelectedItem=$dn } else { $cbProv.SelectedIndex=0 } }
$l2=Lbl '模型' '#D4D4D4' 9 ([System.Drawing.FontStyle]::Regular); $l2.Location=New-Object System.Drawing.Point(400,246)
$cbModel=New-Object System.Windows.Forms.ComboBox
$cbModel.DropDownStyle='DropDownList'; $cbModel.BackColor=C '#252526'; $cbModel.ForeColor=C '#D4D4D4'; $cbModel.FlatStyle='Flat'
$cbModel.Location=New-Object System.Drawing.Point(452,242); $cbModel.Size=New-Object System.Drawing.Size(284,28)
function Fill-Models{
  $cbModel.Items.Clear(); [void]$cbModel.Items.Add('（默认）')
  $key=$null
  if($cbProv.SelectedIndex -gt 0){ $key=$provKeyMap[[string]$cbProv.SelectedItem] } elseif($followProv){ $key=$followProv }
  if($provTable -and $key -and $provTable.$key -and $provTable.$key.models){ foreach($m in @($provTable.$key.models.PSObject.Properties.Name)){ [void]$cbModel.Items.Add($m) } }
  $curModel=[string]$settings.model
  if($curModel -and $cbModel.Items.Contains($curModel)){ $cbModel.SelectedItem=$curModel } else { $cbModel.SelectedIndex=0 }
}
Fill-Models
$cbProv.Add_SelectedIndexChanged({ Fill-Models })
Theme-Combo $cbProv
Theme-Combo $cbModel
$l3=Lbl '超时(ms)' '#D4D4D4' 9 ([System.Drawing.FontStyle]::Regular); $l3.Location=New-Object System.Drawing.Point(26,286)
$txTimeout=New-Object System.Windows.Forms.TextBox
$txTimeout.BackColor=C '#252526'; $txTimeout.ForeColor=C '#D4D4D4'; $txTimeout.BorderStyle='FixedSingle'
$txTimeout.Location=New-Object System.Drawing.Point(110,282); $txTimeout.Size=New-Object System.Drawing.Size(110,26)
$txTimeout.Text=[string]$settings.timeout_ms
$l4=Lbl '缓存(秒)' '#D4D4D4' 9 ([System.Drawing.FontStyle]::Regular); $l4.Location=New-Object System.Drawing.Point(260,286)
$txCache=New-Object System.Windows.Forms.TextBox
$txCache.BackColor=C '#252526'; $txCache.ForeColor=C '#D4D4D4'; $txCache.BorderStyle='FixedSingle'
$txCache.Location=New-Object System.Drawing.Point(344,282); $txCache.Size=New-Object System.Drawing.Size(110,26)
$txCache.Text=[string]$settings.cache_ttl_seconds
$s4=Sec '危险规则（优先于安全子 agent，不经过 LLM）'; $s4.Location=New-Object System.Drawing.Point(26,322)
$listCard=New-Object System.Windows.Forms.Panel
$listCard.BackColor=C '#252526'
$listCard.Location=New-Object System.Drawing.Point(26,348); $listCard.Size=New-Object System.Drawing.Size(466,198)
Round $listCard 12
$lbRules=New-Object System.Windows.Forms.ListBox
$lbRules.BackColor=C '#252526'; $lbRules.ForeColor=C '#D4D4D4'; $lbRules.BorderStyle='None'
$lbRules.Location=New-Object System.Drawing.Point(8,8); $lbRules.Size=New-Object System.Drawing.Size(450,182)
$lbRules.Font=New-Object System.Drawing.Font('Consolas',9)
$lbRules.IntegralHeight=$false
$lbRules.DrawMode='OwnerDrawFixed'; $lbRules.ItemHeight=20
$lbRules.Add_DrawItem({
  param($s,$e)
  if($e.Index -lt 0 -or $e.Index -ge $s.Items.Count){ return }
  $sel=(($e.State -band [System.Windows.Forms.DrawItemState]::Selected) -ne 0)
  $bgHex= if($sel){ '#4C8DFF' } else { '#252526' }
  $fgHex= if($sel){ '#FFFFFF' } else { '#D4D4D4' }
  $br=New-Object System.Drawing.SolidBrush (C $bgHex)
  $e.Graphics.FillRectangle($br,$e.Bounds)
  $tf=New-Object System.Drawing.Font('Consolas',9)
  $tb=New-Object System.Drawing.SolidBrush (C $fgHex)
  $e.Graphics.DrawString([string]$s.Items[$e.Index],$tf,$tb,($e.Bounds.X+4),($e.Bounds.Y+3))
  $br.Dispose(); $tb.Dispose(); $tf.Dispose()
})
$listCard.Controls.Add($lbRules)
function Refresh-Rules{
  $lbRules.Items.Clear()
  $i=1
  foreach($r in $rules){ [void]$lbRules.Items.Add(('#'+$i+' ['+$r.action+'] '+$r.description+'  -  '+$r.pattern)); $i++ }
}
Refresh-Rules
$bAdd=Btn '添加规则' '#4C8DFF' '#FFFFFF'; $bAdd.Size=New-Object System.Drawing.Size(184,38); $bAdd.Location=New-Object System.Drawing.Point(516,348)
$bDel=Btn '删除所选' '#4A2B2E' '#F14C4C'; $bDel.Size=New-Object System.Drawing.Size(184,38); $bDel.Location=New-Object System.Drawing.Point(516,398)
$bTest=Btn '测试命中' '#252526' '#4C8DFF'; $bTest.Size=New-Object System.Drawing.Size(184,38); $bTest.Location=New-Object System.Drawing.Point(516,448)
$bReset=Btn '恢复出厂' '#252526' '#9D9D9D'; $bReset.Size=New-Object System.Drawing.Size(184,38); $bReset.Location=New-Object System.Drawing.Point(516,498)
Round $bAdd 10; Round $bDel 10; Round $bTest 10; Round $bReset 10
$rulesHint=Lbl '动作：deny=拦截 ask=转人工 allow=白名单；正则大小写不敏感' '#9D9D9D' 8.25 ([System.Drawing.FontStyle]::Regular)
$rulesHint.Location=New-Object System.Drawing.Point(26,556)
$bAdd.Add_Click({
  $sf=New-Object System.Windows.Forms.Form
  $sf.Text='添加危险规则'; $sf.BackColor=C '#1E1E1E'; $sf.FormBorderStyle='FixedDialog'; $sf.StartPosition='CenterParent'; $sf.TopMost=$true
  $sf.Size=New-Object System.Drawing.Size(540,250)
  $sa=New-Object System.Windows.Forms.ComboBox; $sa.DropDownStyle='DropDownList'
  $sa.Items.AddRange(@('deny','ask','allow')); $sa.SelectedIndex=0
  $sa.BackColor=C '#252526'; $sa.ForeColor=C '#D4D4D4'; $sa.FlatStyle='Flat'
  $sa.Location=New-Object System.Drawing.Point(100,24); $sa.Size=New-Object System.Drawing.Size(140,28)
  Theme-Combo $sa
  $la=Lbl '动作' '#D4D4D4' 9 ([System.Drawing.FontStyle]::Regular); $la.Location=New-Object System.Drawing.Point(24,28)
  $sp=New-Object System.Windows.Forms.TextBox
  $sp.BackColor=C '#252526'; $sp.ForeColor=C '#D4D4D4'; $sp.BorderStyle='FixedSingle'
  $sp.Font=New-Object System.Drawing.Font('Consolas',9)
  $sp.Location=New-Object System.Drawing.Point(100,62); $sp.Size=New-Object System.Drawing.Size(400,26)
  $lp=Lbl '正则' '#D4D4D4' 9 ([System.Drawing.FontStyle]::Regular); $lp.Location=New-Object System.Drawing.Point(24,66)
  $sd=New-Object System.Windows.Forms.TextBox
  $sd.BackColor=C '#252526'; $sd.ForeColor=C '#D4D4D4'; $sd.BorderStyle='FixedSingle'
  $sd.Location=New-Object System.Drawing.Point(100,100); $sd.Size=New-Object System.Drawing.Size(400,26)
  $ld=Lbl '描述' '#D4D4D4' 9 ([System.Drawing.FontStyle]::Regular); $ld.Location=New-Object System.Drawing.Point(24,104)
  $ok=Btn '确定' '#4C8DFF' '#FFFFFF'; $ok.Size=New-Object System.Drawing.Size(130,40); $ok.Location=New-Object System.Drawing.Point(320,156)
  $no=Btn '取消' '#252526' '#9D9D9D'; $no.Size=New-Object System.Drawing.Size(130,40); $no.Location=New-Object System.Drawing.Point(180,156)
  Round $ok 10; Round $no 10
  $sf.Controls.AddRange(@($la,$sa,$lp,$sp,$ld,$sd,$ok,$no))
  $script:added=$false
  $ok.Add_Click({
    if(-not $sp.Text.Trim()){ [System.Windows.Forms.MessageBox]::Show($sf,'正则不能为空','auto-review'); return }
    try{ [regex]::new($sp.Text,'IgnoreCase,Multiline') | Out-Null }catch{ [System.Windows.Forms.MessageBox]::Show($sf,'正则编译失败: '+$_.Exception.Message,'auto-review'); return }
    $script:added=$true; $sf.Close()
  })
  $no.Add_Click({ $sf.Close() })
  [void]$sf.ShowDialog($f)
  if($script:added){
    $nr=New-Object PSObject -Property @{ pattern=$sp.Text; action=$sa.SelectedItem; description=$sd.Text }
    $rules=@($rules + $nr); Refresh-Rules
  }
})
$bDel.Add_Click({
  if($lbRules.SelectedIndex -lt 0){ [System.Windows.Forms.MessageBox]::Show($f,'先选中一条规则','auto-review'); return }
  $idx=$lbRules.SelectedIndex
  if([System.Windows.Forms.MessageBox]::Show($f,'确定删除规则 '+($idx+1)+' ？','auto-review','YesNo') -eq 'Yes'){
    $list=New-Object System.Collections.ArrayList
    foreach($r in $rules){ [void]$list.Add($r) }
    $list.RemoveAt($idx); $rules=@($list); Refresh-Rules
  }
})
$bTest.Add_Click({
  $cmd=[Microsoft.VisualBasic.Interaction]::InputBox('输入要测试的命令文本','规则命中测试','')
  if($cmd){
    $hits=@(); $i=1
    foreach($r in $rules){ try{ if(([regex]::new($r.pattern,'IgnoreCase,Multiline')).IsMatch($cmd)){ $hits+=('#'+$i+' ['+$r.action+'] '+$r.description) } }catch{}; $i++ }
    $msg= if($hits.Count){ '命中 '+$hits.Count+' 条:'+$NL+($hits -join $NL) } else { '未命中任何规则（将进入安全子 agent 审查）' }
    [System.Windows.Forms.MessageBox]::Show($f,$msg,'规则命中测试')
  }
})
$bReset.Add_Click({
  if([System.Windows.Forms.MessageBox]::Show($f,'恢复出厂规则？当前规则表将被覆盖（自定义规则请先备份）','auto-review','YesNo') -eq 'Yes'){
    $parsed=Get-Content ($env:AR_DEFAULT_RULES) -Raw -Encoding UTF8 | ConvertFrom-Json; $rules=@($parsed | Where-Object { $_ -and $_.pattern }); Refresh-Rules
  }
})
$sep=New-Object System.Windows.Forms.Label
$sep.AutoSize=$false; $sep.Size=New-Object System.Drawing.Size(708,1); $sep.Location=New-Object System.Drawing.Point(26,590)
$sep.BackColor=C '#3E3E42'
$saved=Lbl '' '#9D9D9D' 8.25 ([System.Drawing.FontStyle]::Regular)
$saved.Location=New-Object System.Drawing.Point(26,618); $saved.AutoSize=$true
$bClose=Btn '关 闭' '#252526' '#9D9D9D'
$bClose.Size=New-Object System.Drawing.Size(150,42); $bClose.Location=New-Object System.Drawing.Point(420,606)
$bSave=Btn '保 存' '#4C8DFF' '#FFFFFF'
$bSave.Size=New-Object System.Drawing.Size(150,42); $bSave.Location=New-Object System.Drawing.Point(586,606)
Round $bClose 10; Round $bSave 10
$bSave.Add_Click({
  try{
    $tools=@(); foreach($tn in @('Bash','Write','Edit')){ if($toolChecks[$tn].Tag.checked){ $tools+=$tn } }
    $provVal=''; if($cbProv.SelectedIndex -gt 0){ $provVal=$provKeyMap[[string]$cbProv.SelectedItem] }
    $modelVal=''; if($cbModel.SelectedIndex -gt 0){ $modelVal=[string]$cbModel.SelectedItem }
    $to=0; [int]::TryParse($txTimeout.Text,[ref]$to) | Out-Null; if($to -lt 5000){$to=5000}; if($to -gt 45000){$to=45000}
    $ca=0; [int]::TryParse($txCache.Text,[ref]$ca) | Out-Null; if($ca -lt 0){$ca=0}
    $o=[ordered]@{ enabled=$ckEnabled.Tag.checked; review_tools=$tools; provider=$provVal; model=$modelVal; timeout_ms=$to; cache_ttl_seconds=$ca; max_payload_chars=[int]$settings.max_payload_chars; dialog_on_ask=$ckDialog.Tag.checked }
    $sj=(New-Object PSObject -Property $o) | ConvertTo-Json
    [IO.File]::WriteAllText($settingsPath,$sj,(New-Object System.Text.UTF8Encoding($false)))
    $rules=@($rules | ForEach-Object { $_ })
    $clean=@(); foreach($r in $rules){ if($r -and $r.pattern){ $clean+=[pscustomobject]@{pattern=[string]$r.pattern; action=[string]$r.action; description=[string]$r.description} } }
    $rj= if($clean.Count -eq 0){ '[]' } else { ConvertTo-Json -InputObject @($clean) -Depth 5 }
    [IO.File]::WriteAllText($rulesPath,$rj,(New-Object System.Text.UTF8Encoding($false)))
    $saved.Text='已保存 '+(Get-Date -Format 'HH:mm:ss')
  } catch { [System.Windows.Forms.MessageBox]::Show($f,'保存失败: '+$_.Exception.Message,'auto-review') }
})
$bClose.Add_Click({ $f.Close() })
$f.Controls.AddRange(@($title,$s1,$ckEnabled,$ckDialog,$s2,$s3,$l1,$cbProv,$l2,$cbModel,$l3,$txTimeout,$l4,$txCache,$s4,$listCard,$bAdd,$bDel,$bTest,$bReset,$rulesHint,$sep,$saved,$bClose,$bSave))
[void]$f.Handle
try{ [ARDwm]::ShowWindow($f.Handle,5) | Out-Null }catch{}
$f.Add_Shown({ try{ $dark=1; [ARDwm]::DwmSetWindowAttribute($f.Handle,20,[ref]$dark,4); $cr=2; [ARDwm]::DwmSetWindowAttribute($f.Handle,33,[ref]$cr,4); $f.Activate() } catch {} })
[void]$f.ShowDialog()