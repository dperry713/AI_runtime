/**
 * AIR Control Center — Client Application Logic (Vanilla JS)
 */

document.addEventListener('DOMContentLoaded', () => {
  // State
  let currentSessionId = null;
  let selectedAgentId = 'developer';
  let activeRunId = null;
  let logPollInterval = null;
  let statePollInterval = null;

  // DOM Elements
  const daemonDot = document.getElementById('daemon-dot');
  const daemonStatusText = document.getElementById('daemon-status-text');
  const activeRunsTag = document.getElementById('active-runs-tag');
  const uptimeTag = document.getElementById('uptime-tag');
  const btnRefresh = document.getElementById('btn-refresh');

  const navItems = document.querySelectorAll('.nav-item');
  const tabPanes = document.querySelectorAll('.tab-pane');
  const navRunsCount = document.getElementById('nav-runs-count');
  const navApprovalsCount = document.getElementById('nav-approvals-count');

  const agentCards = document.querySelectorAll('.agent-card');
  const quickPrompts = document.querySelectorAll('.quick-prompt');
  const goalInput = document.getElementById('goal-input');
  const btnDispatchRun = document.getElementById('btn-dispatch-run');

  const studioRunStatus = document.getElementById('studio-run-status');
  const studioOutput = document.getElementById('studio-output');
  const outputMeta = document.getElementById('output-meta');
  const btnClearOutput = document.getElementById('btn-clear-output');

  const runsTbody = document.getElementById('runs-tbody');
  const approvalsList = document.getElementById('approvals-list');
  const logTerminal = document.getElementById('log-terminal');
  const btnClearLogs = document.getElementById('btn-clear-logs');
  const autoScrollLogs = document.getElementById('auto-scroll-logs');

  const cfgProvider = document.getElementById('cfg-provider');
  const cfgModel = document.getElementById('cfg-model');
  const cfgBaseurl = document.getElementById('cfg-baseurl');

  // =========================================================================
  // Navigation Tabs
  // =========================================================================
  navItems.forEach((btn) => {
    btn.addEventListener('click', () => {
      const targetTab = btn.getAttribute('data-tab');
      navItems.forEach((b) => b.classList.remove('active'));
      tabPanes.forEach((p) => p.classList.remove('active'));

      btn.classList.add('active');
      const pane = document.getElementById(`pane-${targetTab}`);
      if (pane) pane.classList.add('active');

      if (targetTab === 'logs') {
        fetchLogs();
      }
    });
  });

  // =========================================================================
  // Agent Persona Selection & Quick Prompts
  // =========================================================================
  agentCards.forEach((card) => {
    card.addEventListener('click', () => {
      agentCards.forEach((c) => c.classList.remove('selected'));
      card.classList.add('selected');
      selectedAgentId = card.getAttribute('data-agent-id');
    });
  });

  quickPrompts.forEach((chip) => {
    chip.addEventListener('click', () => {
      const prompt = chip.getAttribute('data-prompt');
      if (prompt) goalInput.value = prompt;
      goalInput.focus();
    });
  });

  btnClearOutput.addEventListener('click', () => {
    studioOutput.innerHTML = `
      <div class="empty-state">
        <span class="empty-icon">💡</span>
        <p>Output cleared. Dispatch a new run to view execution.</p>
      </div>`;
    studioRunStatus.textContent = 'Idle';
    studioRunStatus.className = 'run-status-badge';
  });

  btnClearLogs.addEventListener('click', () => {
    logTerminal.textContent = '';
  });

  // =========================================================================
  // Polling & Health
  // =========================================================================
  async function checkHealth() {
    try {
      const res = await fetch('/api/health');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();

      if (data.status === 'healthy') {
        daemonDot.className = 'status-dot pulse-green';
        daemonStatusText.textContent = `AIR Daemon Online (v${data.version})`;
        activeRunsTag.textContent = `Runs: ${data.activeRuns ?? 0}`;
        const uptimeSec = Math.floor((data.uptimeMs ?? 0) / 1000);
        uptimeTag.textContent = `Uptime: ${formatDuration(uptimeSec)}`;
        navRunsCount.textContent = data.activeRuns ?? 0;
      } else {
        daemonDot.className = 'status-dot pulse-red';
        daemonStatusText.textContent = 'AIR Daemon Offline';
      }
    } catch {
      daemonDot.className = 'status-dot pulse-red';
      daemonStatusText.textContent = 'AIR Daemon Offline';
    }
  }

  function formatDuration(sec) {
    if (sec < 60) return `${sec}s`;
    const min = Math.floor(sec / 60);
    const s = sec % 60;
    if (min < 60) return `${min}m ${s}s`;
    const h = Math.floor(min / 60);
    return `${h}h ${min % 60}m`;
  }

  // =========================================================================
  // Dispatch Run
  // =========================================================================
  btnDispatchRun.addEventListener('click', async () => {
    const goal = goalInput.value.trim();
    if (!goal) {
      alert('Please enter an objective or goal for the agent.');
      return;
    }

    btnDispatchRun.disabled = true;
    studioRunStatus.textContent = 'Starting...';
    studioRunStatus.className = 'run-status-badge running';

    try {
      // 1. Ensure Session Exists
      if (!currentSessionId) {
        appendOutput(`[System] Creating new session container for agent: ${selectedAgentId}...`);
        const sessionRes = await fetch('/api/sessions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ agentId: selectedAgentId }),
        });
        const sessionData = await sessionRes.json();
        currentSessionId = sessionData.sessionId;
      }

      appendOutput(`[System] Session ID: ${currentSessionId}`);
      appendOutput(`[System] Dispatching run with agent "${selectedAgentId}"...`);
      appendOutput(`[Goal] "${goal}"\n`);

      // 2. Start Run
      const runRes = await fetch('/api/runs/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionId: currentSessionId,
          agentId: selectedAgentId,
          goal,
        }),
      });

      const runData = await runRes.json();
      if (runData.error) {
        appendOutput(`[Error] ${runData.error.message || runData.error}`);
        studioRunStatus.textContent = 'Failed';
        studioRunStatus.className = 'run-status-badge';
        return;
      }

      activeRunId = runData.runId;
      outputMeta.textContent = `Run: ${activeRunId} | Agent: ${selectedAgentId}`;
      appendOutput(`[Runtime] Run registered successfully (Run ID: ${activeRunId}).`);
      appendOutput(`[Policy] Evaluating tool permissions against profile...`);
      appendOutput(`[Execution] Model turn queued in background daemon.\n`);

      studioRunStatus.textContent = 'Active';
      fetchRuns();
    } catch (err) {
      appendOutput(`[Fatal] Failed to dispatch run: ${err.message}`);
      studioRunStatus.textContent = 'Error';
    } finally {
      btnDispatchRun.disabled = false;
    }
  });

  function appendOutput(text) {
    if (studioOutput.querySelector('.empty-state')) {
      studioOutput.innerHTML = '';
    }
    const line = document.createElement('div');
    line.textContent = text;
    studioOutput.appendChild(line);
    studioOutput.scrollTop = studioOutput.scrollHeight;
  }

  // =========================================================================
  // Runs Table
  // =========================================================================
  async function fetchRuns() {
    try {
      const res = await fetch('/api/runs');
      if (!res.ok) return;
      const data = await res.json();
      const runs = data.runs || [];
      navRunsCount.textContent = runs.length;

      if (runs.length === 0) {
        runsTbody.innerHTML = `<tr><td colspan="6" class="text-center text-muted">No runs recorded yet in this daemon session.</td></tr>`;
        return;
      }

      runsTbody.innerHTML = runs.map((r) => `
        <tr>
          <td><code>${escapeHtml(r.runId || '--')}</code></td>
          <td><code>${escapeHtml(r.sessionId || '--')}</code></td>
          <td><span class="badge policy-badge write">${escapeHtml(r.agentId || 'default')}</span></td>
          <td>${escapeHtml(truncate(r.goal || '--', 40))}</td>
          <td><span class="run-status-badge ${r.status === 'running' ? 'running' : 'completed'}">${escapeHtml(r.status || 'unknown')}</span></td>
          <td>
            <button class="btn btn-secondary btn-sm" onclick="cancelRun('${r.runId}')" title="Cancel run">Stop</button>
          </td>
        </tr>
      `).join('');
    } catch {
      // Ignore background poll errors
    }
  }

  window.cancelRun = async function (runId) {
    if (!confirm(`Cancel run ${runId}?`)) return;
    try {
      await fetch('/api/runs/cancel', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ runId }),
      });
      fetchRuns();
    } catch (err) {
      alert(`Error cancelling run: ${err.message}`);
    }
  };

  // =========================================================================
  // Approvals List
  // =========================================================================
  async function fetchApprovals() {
    try {
      const res = await fetch('/api/approvals');
      if (!res.ok) return;
      const data = await res.json();
      const approvals = data.approvals || [];
      navApprovalsCount.textContent = approvals.length;

      if (approvals.length === 0) {
        approvalsList.innerHTML = `
          <div class="empty-state">
            <span class="empty-icon">🛡️</span>
            <p>No pending approvals. When a tool call requires human authorization, it will appear here.</p>
          </div>`;
        return;
      }

      approvalsList.innerHTML = approvals.map((a) => `
        <div class="approval-card">
          <div>
            <strong>Tool Call: <code>${escapeHtml(a.toolName)}</code></strong>
            <p class="text-muted mt-1">Requested by Run: <code>${escapeHtml(a.runId)}</code></p>
          </div>
          <div class="action-row">
            <button class="btn btn-secondary btn-sm" onclick="resolveApproval('${a.approvalId}', 'deny')">Deny</button>
            <button class="btn btn-primary btn-sm" onclick="resolveApproval('${a.approvalId}', 'approve')">Approve</button>
          </div>
        </div>
      `).join('');
    } catch {
      // Ignore background poll errors
    }
  }

  window.resolveApproval = async function (approvalId, decision) {
    try {
      await fetch('/api/approvals/resolve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ approvalId, decision }),
      });
      fetchApprovals();
    } catch (err) {
      alert(`Error resolving approval: ${err.message}`);
    }
  };

  // =========================================================================
  // Live Telemetry / Logs
  // =========================================================================
  async function fetchLogs() {
    try {
      const res = await fetch('/api/logs?limit=40');
      if (!res.ok) return;
      const data = await res.json();
      const lines = data.lines || [];

      if (lines.length > 0) {
        logTerminal.textContent = lines.join('\n');
        if (autoScrollLogs.checked) {
          logTerminal.scrollTop = logTerminal.scrollHeight;
        }
      }
    } catch {
      // Ignore background poll errors
    }
  }

  function truncate(str, max) {
    return str.length > max ? str.substring(0, max) + '...' : str;
  }

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  // Load provider display
  if (cfgProvider) {
    cfgProvider.textContent = 'NVIDIA NIM / OpenAI-compat';
    cfgModel.textContent = 'meta/llama-3.1-70b-instruct';
    cfgBaseurl.textContent = 'https://integrate.api.nvidia.com/v1';
  }

  // =========================================================================
  // Polling Intervals
  // =========================================================================
  checkHealth();
  fetchRuns();
  fetchApprovals();
  fetchLogs();

  btnRefresh.addEventListener('click', () => {
    checkHealth();
    fetchRuns();
    fetchApprovals();
    fetchLogs();
  });

  statePollInterval = setInterval(() => {
    checkHealth();
    fetchRuns();
    fetchApprovals();
  }, 3000);

  logPollInterval = setInterval(() => {
    const logsTab = document.getElementById('pane-logs');
    if (logsTab && logsTab.classList.contains('active')) {
      fetchLogs();
    }
  }, 2000);
});
