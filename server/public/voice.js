/* Browser recording works over the existing Tailscale HTTPS connection. */
(() => {
  const button = $('dictate');
  const status = document.createElement('div');
  status.id = 'voice-status';
  status.hidden = true;
  status.setAttribute('role', 'status');
  $('composer').before(status);
  let active = null;

  function report(message, retry = false) {
    status.replaceChildren(document.createTextNode(message));
    status.hidden = false;
    if (retry) {
      const b = document.createElement('button');
      b.className = 'ghost';
      b.textContent = 'Retry';
      b.onclick = () => upload(active);
      status.append(b);
    }
    const cancel = document.createElement('button');
    cancel.className = 'ghost';
    cancel.textContent = 'Cancel';
    cancel.onclick = () => window.cancelDictation();
    status.append(cancel);
  }

  function release(job) {
    clearInterval(job.timer);
    if (job.recorder?.state !== 'inactive' && job.recorder) job.recorder.stop();
    job.stream?.getTracks().forEach((track) => track.stop());
  }

  window.dictationBusy = () => Boolean(active);
  window.cancelDictation = () => {
    const job = active;
    active = null;
    if (job) {
      job.controller?.abort();
      release(job);
    }
    button.disabled = false;
    button.classList.remove('recording');
    button.textContent = '🎙';
    button.setAttribute('aria-label', 'Record voice message');
    status.hidden = true;
  };

  window.voiceSetup = () => {
    openSheet(`<h2>Voice setup</h2>
      <p>Record on your phone; OpenAI transcribes the audio. Review the text before sending.</p>
      <label>OpenAI API key</label>
      <input id="voice-key" type="password" autocomplete="off" placeholder="Enter API key" />
      <button id="voice-save" class="primary">Save key</button>
      <p id="voice-save-status" role="status"></p>`);
    $('voice-save').onclick = async () => {
      const apiKey = $('voice-key').value.trim();
      if (!apiKey) return;
      $('voice-save').disabled = true;
      try {
        await api('/api/models/key', { method: 'POST', body: JSON.stringify({ alias: '__transcription', apiKey }) });
        $('voice-key').value = '';
        closeSheet();
        showBanner('Voice key saved. Tap the microphone to dictate.');
      } catch (error) {
        if ($('voice-save-status')) $('voice-save-status').textContent = error.message;
      } finally {
        if ($('voice-save')) $('voice-save').disabled = false;
      }
    };
  };

  async function upload(job) {
    if (!job || active !== job || !job.blob) return;
    button.disabled = true;
    button.classList.remove('recording');
    button.textContent = '…';
    report('Transcribing…');
    job.controller = new AbortController();
    const timeout = setTimeout(() => job.controller.abort(), 100_000);
    try {
      const response = await fetch('/api/transcription', {
        method: 'POST', headers: { 'Content-Type': job.blob.type },
        body: job.blob, signal: job.controller.signal,
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Transcription failed.');
      if (active !== job) return;
      if (typeof result.text !== 'string' || !result.text.trim()) throw new Error('No speech detected. Cancel and try recording again.');
      const input = $('input');
      input.value += (input.value && !/\s$/.test(input.value) ? ' ' : '') + result.text.trim();
      input.dispatchEvent(new Event('input'));
      window.cancelDictation();
      showBanner('Transcribed. Review your message, then send.');
    } catch (error) {
      if (active === job) report(error.name === 'AbortError' ? 'Transcription timed out.' : error.message, true);
    } finally {
      clearTimeout(timeout);
    }
  }

  button.onclick = async () => {
    if (active?.recorder?.state === 'recording') {
      release(active);
      return;
    }
    if (active) return;
    if (!cur().session) return showBanner('Open a session first.');
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) {
      return showBanner('Voice recording needs Safari or Chrome using your HTTPS Tailscale URL.');
    }
    const job = { chunks: [], bytes: 0 };
    active = job;
    button.disabled = true;
    report('Opening microphone…');
    try {
      // Request permission directly from the tap, before network work (iOS).
      job.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (active !== job) { release(job); return; }
      const config = await api('/api/transcription');
      if (active !== job) { release(job); return; }
      if (!config.configured) {
        window.cancelDictation();
        window.voiceSetup();
        return;
      }
      const mimeType = ['audio/mp4', 'audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus']
        .find((type) => MediaRecorder.isTypeSupported(type));
      if (!mimeType) throw new Error('This browser has no supported recording format. Try Safari or Chrome.');
      job.recorder = new MediaRecorder(job.stream, { mimeType, audioBitsPerSecond: 64000 });
      job.recorder.ondataavailable = ({ data }) => {
        if (active !== job || !data.size) return;
        job.chunks.push(data);
        job.bytes += data.size;
        if (job.bytes > 19_000_000) release(job);
      };
      job.recorder.onerror = () => {
        if (active !== job) return;
        window.cancelDictation();
        showBanner('Recording was interrupted. Please try again.');
      };
      job.recorder.onstop = () => {
        release(job);
        if (active !== job) return;
        job.blob = new Blob(job.chunks, { type: job.recorder.mimeType });
        job.chunks = [];
        upload(job);
      };
      job.recorder.start(1000);
      job.started = Date.now();
      button.disabled = false;
      button.textContent = '■';
      button.classList.add('recording');
      button.setAttribute('aria-label', 'Stop recording and transcribe');
      report('Recording 0:00 — tap ■ when finished.');
      job.timer = setInterval(() => {
        const seconds = Math.floor((Date.now() - job.started) / 1000);
        report(`Recording ${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')} — tap ■ when finished.`);
        if (seconds >= 300) release(job);
      }, 1000);
    } catch (error) {
      if (active !== job) { release(job); return; }
      window.cancelDictation();
      showBanner(error.name === 'NotAllowedError' ? 'Microphone permission denied. Allow microphone access in Safari’s website settings.' : error.message);
    }
  };
  window.addEventListener('pagehide', () => window.cancelDictation());
})();
