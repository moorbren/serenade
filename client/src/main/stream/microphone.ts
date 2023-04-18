import MainWindow from "../windows/main";
import RendererBridge from "../bridge";
import Settings from "../settings";
import SettingsWindow from "../windows/settings";
import Window from "../windows/window";
const { SpeechRecorder, devices } = require("speech-recorder");

declare var __static: string;

type MicrophoneInput = {
  id: number;
  name: string;
  selected?: boolean;
  defaultSampleRate?: number;
};

type SpeechRecorderDevice = {
  id: number,
  name: string,
  apiName: string,
  maxInputChannels: number,
  maxOutputChannels: number,
  defaultSampleRate: number,
  isDefaultInput: boolean,
  isDefaultOutput: boolean
}

export default class Microphone {
  private callbacks: { [key: string]: (message: any) => void } = {};
  private recorder: any = null;
  private volumeWhileSpeakingBuffer: number[] = [];
  private volumeWhileSpeakingBufferSize = 10;

  // determined empirically by testing across a few different microphones and
  // used only as a visual indicator of volume, not used to determine speech
  private volumeNormalization = 5000;

  static systemDefaultMicrophone = { id: -1, name: "System Default" };
  running = false;

  constructor(
    private bridge: RendererBridge,
    private mainWindow: MainWindow,
    private settings: Settings,
    private settingsWindow: () => Promise<SettingsWindow> | undefined
  ) {}

  private calculateNormalizedVolume(volume: number): number {
    return Math.max(0, Math.min(1, volume / this.volumeNormalization));
  }

  private start() {
    if (this.running) {
      return;
    }

    this.running = true;
    this.volumeWhileSpeakingBuffer = [];


    const microphoneId = this.settings.getMicrophone().id;
    const selectedMicrophone = this.microphones().find(mic => mic.id === microphoneId);

    this.recorder = new SpeechRecorder({
      device: microphoneId,
      sampleRate: selectedMicrophone?.defaultSampleRate || 16000,

      sileroVadSilenceThreshold: this.settings.getChunkSilenceThreshold(),
      sileroVadSpeechThreshold: this.settings.getChunkSpeechThreshold(),

      onChunkStart: ({ audio }: { audio: any }) => {
        this.volumeWhileSpeakingBuffer = [];
        for (const callback of Object.values(this.callbacks)) {
          callback({ event: "chunk_start", audio });
        }
      },

      onAudio: async ({
        audio,
        consecutiveSilence,
        speaking,
        volume,
      }: {
        audio: any;
        consecutiveSilence: number;
        speaking: boolean;
        volume: number;
      }) => {
        // use only the start of each speech chunk for the low volume warning, or else we'll
        // always show it, since we're still speaking during the trailing buffer
        if (
          speaking &&
          this.volumeWhileSpeakingBuffer.length < this.volumeWhileSpeakingBufferSize
        ) {
          this.volumeWhileSpeakingBuffer.push(volume);
        }

        // debounce UI updates so we don't overwhelm the client
        if (Math.random() < 0.2) {
          let windows: Window[] = [this.mainWindow];
          if (this.settingsWindow() && (await this.settingsWindow()!).shown()) {
            windows.push(await this.settingsWindow()!);
          }

          this.bridge.setState(
            {
              speakingVolume:
                this.volumeWhileSpeakingBuffer.length == this.volumeWhileSpeakingBufferSize
                  ? this.volumeWhileSpeakingBuffer.reduce((a, b) => a + b) /
                    this.volumeWhileSpeakingBuffer.length
                  : 0,
              volume: this.calculateNormalizedVolume(volume),
            },
            windows
          );
        }

        for (const callback of Object.values(this.callbacks)) {
          callback({ event: "audio", audio, volume, speaking, consecutiveSilence });
        }
      },

      onChunkEnd: () => {
        for (const callback of Object.values(this.callbacks)) {
          callback({ event: "chunk_end" });
        }
      },
    });

    this.recorder.start();
  }

  changeMicrophone(microphone: { id: number; name: string }) {
    this.stop();
    this.settings.setMicrophone(microphone);
    if (Object.keys(this.callbacks).length > 0) {
      setTimeout(() => {
        this.start();
      }, 1000);
    }
  }

microphones(): MicrophoneInput[] {
    const inputs: [SpeechRecorderDevice] = devices().filter((e: any) => e.maxInputChannels > 0);
    const defaultInputDevice = inputs.find(i => i.isDefaultInput);

    // very important to include the sample rate here
      // the speech processor does not handle default sample rates of devices
      // It defaults to 16000hz for each device, if it's not supported, the program will crash
    const microphones : [MicrophoneInput] = [{
      id: Microphone.systemDefaultMicrophone.id,
      name: Microphone.systemDefaultMicrophone.name,
      defaultSampleRate: defaultInputDevice?.defaultSampleRate,
      selected: Microphone.systemDefaultMicrophone.id == this.settings.getMicrophone().id,
    }];

    inputs.forEach(e => {
      microphones.push({
        id: e.id,
        name: e.name,
        defaultSampleRate: e.defaultSampleRate,
        selected: e.id == this.settings.getMicrophone().id,
      })
    });

    return microphones;
  }

  register(name: string, callback: (data: any) => void) {
    if (Object.keys(this.callbacks).length == 0) {
      this.start();
    }

    this.callbacks[name] = callback;
  }

  stop() {
    if (!this.running) {
      return;
    }

    this.recorder.stop();
    this.running = false;
  }

  unregister(name: string) {
    delete this.callbacks[name];
    if (Object.keys(this.callbacks).length == 0) {
      this.stop();
    }
  }
}
