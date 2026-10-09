'use strict';
window.loadSkillsManager = async function () {
  const box = document.querySelector('#skills-manager'); if (!box) return;
  let data, project = state.projects.find(p => p.id === view.project)?.id || state.projects[0]?.id || '';
  const draw = () => {
    if (!box.isConnected) return;
    const ids = data.projects[project] || [], found = new Set(data.items.map(x => x.id));
    box.innerHTML = `<h2>Skill 管理</h2><p>設定技能來源，再為各專案勾選技能。下次傳送需求或啟動終端機時，AI 會收到讀取原始 SKILL.md 的指示。執行中的工作不受影響。</p>
    <label for="skill-roots">技能資料夾（每行一個完整路徑）</label><textarea id="skill-roots" rows="3" style="width:100%" spellcheck="false">${esc(data.roots.join('\n'))}</textarea>
    <div class="acts"><button class="btn plain" id="skill-browse">加入資料夾</button><button class="btn" id="skill-roots-save">儲存來源並掃描</button><button class="btn plain" id="skill-refresh">重新掃描</button></div>
    <p class="small">只讀取技能原檔，不複製或修改。跨 AI 工具的相容性須依技能內容確認。</p>
    <label for="skill-project">選擇專案</label><select id="skill-project" ${state.projects.length ? '' : 'disabled'}>${state.projects.map(p => `<option value="${esc(p.id)}" ${p.id === project ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}</select>
    ${project ? '' : '<p>先建立專案，即可選用技能。</p>'}
    <div style="max-height:340px;overflow:auto">${data.items.map(x => `<label style="display:block;padding:10px 0;border-bottom:1px solid #8884"><input type="checkbox" data-skill-id="${x.id}" ${ids.includes(x.id) ? 'checked' : ''} ${project ? '' : 'disabled'}> <b>${esc(x.name)}</b><br><span data-no-translate>${esc(x.description)}</span><br><small class="path">${esc(x.path)}</small><br><small>${esc(x.compatibility)}</small></label>`).join('') || '<p>找不到 SKILL.md，請檢查來源資料夾。</p>'}</div>
    ${ids.filter(x => !found.has(x)).length ? '<p>部分已選技能遺失。儲存目前選擇後，會移除失效項目。</p>' : ''}
    ${data.warnings.map(x => `<p>${esc(x)}</p>`).join('')}
    <div class="acts"><button class="btn" id="skill-selection-save" ${project ? '' : 'disabled'}>儲存此專案技能</button><span>找到 ${data.items.length} 個技能</span></div><p id="skill-notice" role="status"></p>`;
    const run = async (button, work) => { button.disabled = true; try { await work(); } catch(e) { box.querySelector('#skill-notice').textContent = e.message; } finally { button.disabled = false; } };
    box.querySelector('#skill-browse').onclick = e => run(e.currentTarget, async () => { const r = await api('/api/pick-folder', {}); if (r.path) { const field = box.querySelector('#skill-roots'); field.value = [field.value.trim(), r.path.trim()].filter(Boolean).join('\n'); } });
    box.querySelector('#skill-roots-save').onclick = e => run(e.currentTarget, async () => { data = await api('/api/skills/roots', { roots: box.querySelector('#skill-roots').value.split(/\r?\n/).map(x => x.trim()).filter(Boolean) }); draw(); box.querySelector('#skill-notice').textContent = '來源已儲存，掃描完成。'; });
    box.querySelector('#skill-refresh').onclick = e => run(e.currentTarget, async () => { data = await api('/api/skills'); draw(); });
    box.querySelector('#skill-project').onchange = e => { project = e.target.value; draw(); };
    box.querySelector('#skill-selection-save').onclick = e => run(e.currentTarget, async () => { const ids = [...box.querySelectorAll('[data-skill-id]:checked')].map(x => x.dataset.skillId); await api('/api/skills/project', { project, ids }); data.projects[project] = ids; box.querySelector('#skill-notice').textContent = `已儲存 ${ids.length} 個技能，下次傳送需求時套用。`; });
  };
  try { data = await api('/api/skills'); draw(); } catch(e) { box.innerHTML = `<h2>Skill 管理</h2><p>${esc(e.message)}</p>`; }
};
