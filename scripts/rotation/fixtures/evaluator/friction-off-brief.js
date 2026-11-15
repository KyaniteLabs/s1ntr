// friction: off-brief — Tone.js instead of kinetic CSS
const synth = new Tone.Synth().toDestination();
Tone.Transport.bpm.value = 90;
Tone.Transport.scheduleRepeat((time) => {
  synth.triggerAttackRelease('C4', '8n', time);
}, '4n');
