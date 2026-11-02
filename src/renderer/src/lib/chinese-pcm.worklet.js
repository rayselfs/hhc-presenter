/* eslint-disable @typescript-eslint/explicit-function-return-type -- AudioWorklet is a standalone JavaScript asset. */
class ChinesePcmCapture extends AudioWorkletProcessor {
  constructor() {
    super()
    this.buffer = new Float32Array(320)
    this.offset = 0
    this.frame = 0
    this.closed = false
    this.port.onmessage = (event) => {
      if (event.data !== 'finish' || this.closed) return
      this.closed = true
      if (this.offset) {
        const pcm = this.buffer.slice(0, this.offset)
        this.port.postMessage({ pcm: pcm.buffer, frame: this.frame }, [pcm.buffer])
      }
      this.port.postMessage({ finished: true })
    }
  }
  process(inputs) {
    if (this.closed) return false
    const channels = inputs[0]
    if (!channels?.length) return true
    for (let i = 0; i < channels[0].length; i++) {
      if (this.offset === 0) this.frame = currentFrame + i
      let sample = 0
      for (const channel of channels) sample += channel[i] / channels.length
      this.buffer[this.offset++] = sample
      if (this.offset === 320) {
        this.port.postMessage({ pcm: this.buffer.buffer, frame: this.frame }, [this.buffer.buffer])
        this.buffer = new Float32Array(320)
        this.offset = 0
      }
    }
    return true
  }
}
registerProcessor('chinese-pcm-capture', ChinesePcmCapture)
