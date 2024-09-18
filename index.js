// index.js
const { InstanceBase, Regex, runEntrypoint, combineRgb} = require('@companion-module/base');
const net = require('net');
const dgram = require('dgram');
const zlib = require('zlib');

class UCControlInstance extends InstanceBase {
  constructor(internal) {
    super(internal);

    this.config = {};
    this.channelStates = {}; // Store channel states
    this.mixerBypassState = false; //assumes begins in not-bypassed state
    this.receiveBuffer = Buffer.alloc(0); // For TCP data accumulation
  }

  async init(config) {
    this.config = config;

    this.updateStatus('connecting');

    this.initTCP();
    this.initUDP();

    this.initActions();
    this.initFeedbacks(); // Initialize feedbacks

    // Start heartbeat task
    this.startHeartbeat();
  }

  async destroy() {
    if (this.tcpClient) {
      this.tcpClient.destroy();
      this.tcpClient = null;
    }
    if (this.udpServer) {
      this.udpServer.close();
      this.udpServer = null;
    }
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
    }
  }

  async configUpdated(config) {
    this.config = config;
    this.initTCP();
    this.initUDP();
  }

  getConfigFields() {
    return [
      {
        type: 'textinput',
        id: 'host',
        label: 'Device IP Address',
        width: 6,
        regex: Regex.IP,
        required: true,
      },
    ];
  }

  initTCP() {
    if (this.tcpClient) {
      this.tcpClient.destroy();
      this.tcpClient = null;
    }

    if (this.config.host) {
      this.tcpClient = new net.Socket();

      this.tcpClient.connect(49162, this.config.host, () => {
        this.log('info', 'Connected to UC device');
        this.updateStatus('ok');
        this.subscribeToDevice();
      });

      this.tcpClient.on('error', (err) => {
        this.log('error', 'TCP error: ' + err.message);
        this.updateStatus('connection_failure');
      });

      this.tcpClient.on('data', (data) => {
        this.handleIncomingData(data);
      });

      this.tcpClient.on('close', () => {
        this.log('info', 'TCP connection closed');
        this.updateStatus('disconnected');
      });
    }
  }

  initUDP() {
    if (this.udpServer) {
      this.udpServer.close();
      this.udpServer = null;
    }

    this.udpServer = dgram.createSocket('udp4');

    this.udpServer.on('error', (err) => {
      this.log('error', `UDP error: ${err.stack}`);
      this.udpServer.close();
    });

    this.udpServer.on('message', (msg, rinfo) => {
      this.handleIncomingUDPData(msg);
    });

    this.udpServer.bind(() => {
      this.udpPort = this.udpServer.address().port;
      this.log('info', `UDP server listening on port ${this.udpPort}`);
    });
  }

  subscribeToDevice() {
    // Send UM packet with UDP port
    const umPacket = this.buildUMPacket(this.udpPort);
    this.sendPacket(umPacket);

    // Send JM packet to subscribe
    const jmPacket = this.buildJMPacket();
    this.sendPacket(jmPacket);
  }

  startHeartbeat() {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
    }

    this.heartbeatInterval = setInterval(() => {
      const kaPacket = this.buildKAPacket();
      this.sendPacket(kaPacket);
    }, 2000); // Every 2 seconds
  }

  initActions() {
    const actions = {};

    actions['set_mixer_bypass'] = {
      name: 'Set Mixer Bypass',
      options: [
        {
          type: 'dropdown',
          label: 'State',
          id: 'state',
          choices: [
            { id: 'true', label: 'Enable' },
            { id: 'false', label: 'Disable' },
          ],
          default: 'false',
        },
      ],
      callback: async (event) => {
        const bypass = event.options.state === 'true';
        this.setMixerBypass(bypass);
      },
    };

    actions['set_channel_mute'] = {
      name: 'Set Channel Mute',
      options: [
        {
          type: 'number',
          label: 'Channel Number',
          id: 'channel',
          min: 1,
          max: 100,
          default: 1,
          required: true,
        },
        {
          type: 'dropdown',
          label: 'Mute State',
          id: 'state',
          choices: [
            { id: 'true', label: 'Mute' },
            { id: 'false', label: 'Unmute' },
          ],
          default: 'true',
        },
      ],
      callback: async (event) => {
        const channel = event.options.channel;
        const mute = event.options.state === 'true';
        this.setChannelMute(channel, mute);
      },
    };

    actions['toggle_channel_mute'] = {
      name: 'Toggle Channel Mute',
      options: [
        {
          type: 'number',
          label: 'Channel Number',
          id: 'channel',
          min: 1,
          max: 100,
          default: 1,
          required: true,
        },
      ],
      callback: async (event) => {
        const channel = event.options.channel;
        this.toggleChannelMute(channel);
      },
    };
	// Toggle Solo
  actions['toggle_channel_solo'] = {
    name: 'Toggle Channel Solo',
    options: [
      {
        type: 'number',
        label: 'Channel Number',
        id: 'channel',
        min: 1,
        max: 100,
        default: 1,
        required: true,
      },
    ],
    callback: async (event) => {
      const channel = event.options.channel;
      this.toggleChannelSolo(channel);
    },
  };

  // Toggle 48V
  actions['toggle_channel_48v'] = {
    name: 'Toggle Channel 48V (Phantom Power)',
    options: [
      {
        type: 'number',
        label: 'Channel Number',
        id: 'channel',
        min: 1,
        max: 100,
        default: 1,
        required: true,
      },
    ],
    callback: async (event) => {
      const channel = event.options.channel;
      this.toggleChannel48V(channel);
    },
  };

  // Toggle HPF
  actions['toggle_channel_hpf'] = {
    name: 'Toggle Channel HPF (High-Pass Filter)',
    options: [
      {
        type: 'number',
        label: 'Channel Number',
        id: 'channel',
        min: 1,
        max: 100,
        default: 1,
        required: true,
      },
    ],
    callback: async (event) => {
      const channel = event.options.channel;
      this.toggleChannelHPF(channel);
    },
  };

  // Toggle Pad
  actions['toggle_channel_pad'] = {
    name: 'Toggle Channel Pad',
    options: [
      {
        type: 'number',
        label: 'Channel Number',
        id: 'channel',
        min: 1,
        max: 100,
        default: 1,
        required: true,
      },
    ],
    callback: async (event) => {
      const channel = event.options.channel;
      this.toggleChannelPad(channel);
    },
  };

  // Toggle Mixer Bypass
  actions['toggle_mixer_bypass'] = {
    name: 'Toggle Mixer Bypass',
    options: [],
    callback: async (event) => {
      this.toggleMixerBypass();
    },
  };

    this.setActionDefinitions(actions);
  }

  sendPacket(packet) {
    if (this.tcpClient && !this.tcpClient.destroyed) {
      this.tcpClient.write(packet);
    } else {
      this.log('error', 'TCP client is not connected');
    }
  }

initFeedbacks() {
    const feedbacks = {};

    // Feedback for Channel Mute State
    feedbacks['channel_mute_state'] = {
      type: 'boolean',
      name: 'Change Button Color by Channel Mute State',
      description: 'Change the button color based on the mute state of a channel',
      options: [
        {
          type: 'number',
          label: 'Channel Number',
          id: 'channel',
          min: 1,
          max: 100,
          default: 1,
          required: true,
        },
        {
          type: 'colorpicker',
          label: 'Muted Color',
          id: 'mutedColor',
          default: combineRgb(255, 0, 0), // Red
        },
        {
          type: 'colorpicker',
          label: 'Unmuted Color',
          id: 'unmutedColor',
          default: combineRgb(0, 255, 0), // Green
        },
      ],
      callback: (feedback) => {
      const channel = feedback.options.channel;
      const channelState = this.channelStates[channel];

      // Add logging
//       this.log('info', `Feedback callback called for channel ${channel}`);
//       this.log('info', `Channel state: ${JSON.stringify(channelState)}`);

      if (channelState && typeof channelState.mute === 'boolean') {
//         this.log('info', `Channel ${channel} mute state is ${channelState.mute}`);
        if (channelState.mute) {
          return { bgcolor: feedback.options.mutedColor };
        } else {
          return { bgcolor: feedback.options.unmutedColor };
        }
      }
//       this.log('info', `Channel ${channel} mute state is unknown`);
      return null;
    },
  };

    feedbacks['channel_solo_state'] = {
    type: 'boolean',
    name: 'Change Button Color by Channel Solo State',
    description: 'Change the button color based on the solo state of a channel',
    options: [
      {
        type: 'number',
        label: 'Channel Number',
        id: 'channel',
        min: 1,
        max: 100,
        default: 1,
        required: true,
      },
      {
        type: 'colorpicker',
        label: 'Solo Active Color',
        id: 'soloColor',
        default: combineRgb(255, 255, 0), // Yellow
      },
      {
        type: 'colorpicker',
        label: 'Solo Inactive Color',
        id: 'normalColor',
        default: combineRgb(0, 0, 0), // Black
      },
    ],
    callback: (feedback) => {
      const channel = feedback.options.channel;
      const channelState = this.channelStates[channel];

      if (channelState && typeof channelState.solo === 'boolean') {
        if (channelState.solo) {
          return { bgcolor: feedback.options.soloColor };
        } else {
          return { bgcolor: feedback.options.normalColor };
        }
      }
      return null;
    },
  };

  feedbacks['channel_hpf_state'] = {
    type: 'boolean',
    name: 'Change Button Color by Channel HPF State',
    description: 'Change the button color based on the hpf state of a channel',
    options: [
      {
        type: 'number',
        label: 'Channel Number',
        id: 'channel',
        min: 1,
        max: 100,
        default: 1,
        required: true,
      },
      {
        type: 'colorpicker',
        label: 'HPF Active Color',
        id: 'hpfColor',
        default: combineRgb(85, 85, 255), // Blue
      },
      {
        type: 'colorpicker',
        label: 'HPF Inactive Color',
        id: 'normalColor',
        default: combineRgb(0, 0, 0), // Black
      },
    ],
    callback: (feedback) => {
      const channel = feedback.options.channel;
      const channelState = this.channelStates[channel];

      if (channelState && typeof channelState.hpf === 'boolean') {
        if (channelState.hpf) {
          return { bgcolor: feedback.options.hpfColor };
        } else {
          return { bgcolor: feedback.options.normalColor };
        }
      }
      return null;
    },
  };
  feedbacks['channel_48v_state'] = {
  type: 'boolean',
  name: 'Change Button Color by Channel 48V State',
  description: 'Change the button color based on the 48V state of a channel',
  options: [
    {
      type: 'number',
      label: 'Channel Number',
      id: 'channel',
      min: 1,
      max: 100,
      default: 1,
      required: true,
    },
    {
      type: 'colorpicker',
      label: '48V On Color',
      id: 'onColor',
      default: combineRgb(0, 0, 255), // Blue
    },
    {
      type: 'colorpicker',
      label: '48V Off Color',
      id: 'offColor',
      default: combineRgb(0, 0, 0), // Black
    },
  ],
  callback: (feedback) => {
    const channel = feedback.options.channel;
    const channelState = this.channelStates[channel];

    if (channelState && typeof channelState['48v'] === 'boolean') {
      if (channelState['48v']) {
        return { bgcolor: feedback.options.onColor };
      } else {
        return { bgcolor: feedback.options.offColor };
      }
    }
    return null;
  },
};

    // Feedback for Mixer Bypass State
    feedbacks['mixer_bypass_state'] = {
      type: 'boolean',
      name: 'Change Button Color by Mixer Bypass State',
      description: 'Change the button color based on the mixer bypass state',
      options: [
        {
          type: 'colorpicker',
          label: 'Bypass Active Color',
          id: 'bypassedColor',
          default: combineRgb(255, 0, 0), // Red
        },
        {
          type: 'colorpicker',
          label: 'Bypass Inactive Color',
          id: 'activeColor',
          default: combineRgb(0, 255, 0), // Green
        },
      ],
      callback: (feedback) => {
        if (typeof this.mixerBypassState === 'boolean') {
          if (this.mixerBypassState) {
            return { bgcolor: feedback.options.bypassedColor };
          } else {
            return { bgcolor: feedback.options.activeColor };
          }
        }
        return null;
      },
    };

    this.setFeedbackDefinitions(feedbacks);
  }

handleIncomingData(data) {
  // Log the raw data received
  this.log('debug', `Received TCP data (hex): ${data.toString('hex')}`);
  this.log('debug', `Received TCP data (ascii): ${data.toString('ascii')}`);
  // Append the new data to the buffer
  this.receiveBuffer = Buffer.concat([this.receiveBuffer, data]);

  // Process the buffer while there is enough data for a header
  while (this.receiveBuffer.length >= 6) {
    // Look for the 'UC' header
    let headerIndex = this.receiveBuffer.indexOf('UC', 0, 'ascii');

    if (headerIndex === -1) {
      // 'UC' not found, discard the buffer
      this.log('warn', 'No valid header found in TCP data, discarding buffer');
      this.receiveBuffer = Buffer.alloc(0);
      break;
    }

    // If 'UC' is not at position 0, discard data before the header
    if (headerIndex > 0) {
      this.log('warn', `Discarding ${headerIndex} bytes before 'UC' header`);
      this.receiveBuffer = this.receiveBuffer.slice(headerIndex);
    }

    // Now check if we have enough data for a full header
    if (this.receiveBuffer.length < 6) {
      // Wait for more data
      break;
    }

    // Verify the rest of the header
    if (this.receiveBuffer.readUInt16LE(2) !== 1) {
      // Invalid version, discard the 'UC' and continue searching
      this.log('warn', 'Invalid version in header, discarding and searching for next header');
      this.receiveBuffer = this.receiveBuffer.slice(2);
      continue;
    }

    // Read the packet size
    const size = this.receiveBuffer.readUInt16LE(4);
    const totalSize = 6 + size;

    if (this.receiveBuffer.length < totalSize) {
      // Wait for more data
      break;
    }

    // Extract the packet data
    const packetData = this.receiveBuffer.slice(0, totalSize);
    this.receiveBuffer = this.receiveBuffer.slice(totalSize);

    // Parse the packet
    try {
      const packet = this.parsePacket(packetData);
      if (packet) {
        if (packet.type === 'ZM') {
          this.handleZMPacket(packet);
        } else if (packet.type === 'PV') {
          this.handlePVPacket(packet);
        }
        // Handle other packet types as needed
      }
    } catch (error) {
      this.log('error', `Error parsing TCP packet: ${error.message}`);
      // Discard the current 'UC' header and try to find the next one
      this.receiveBuffer = this.receiveBuffer.slice(2);
    }
  }
}


handleIncomingUDPData(data) {
  try {
    // Check if the packet starts with 'UC\x00\x01'
    if (data.length >= 6 && data.toString('ascii', 0, 2) === 'UC' && data.readUInt16LE(2) === 1) {
      // Parse the packet using parsePacket
      const packet = this.parsePacket(data);
      if (packet) {
        if (packet.type === 'ZM') {
          this.handleZMPacket(packet);
        } else if (packet.type === 'PV') {
          this.handlePVPacket(packet);
        }
        // Add handling for other packet types if necessary
      }
    } else {
      // Handle or ignore packets without the 'UC\x00\x01' header
      // For now, we can log that an unknown UDP packet was received, if needed
      // this.log('debug', 'Received UDP packet without UC header');
      // Or simply ignore it
    }
  } catch (error) {
    this.log('error', `Error parsing UDP data: ${error.message}`);
  }
}
parsePacket(data) {
  if (data.length < 6) {
    throw new Error('Packet too small to be valid');
  }

  const header = data.slice(0, 6);
  if (header.toString('ascii', 0, 2) !== 'UC' || header.readUInt16LE(2) !== 1) {
    throw new Error('Invalid header');
  }

  const size = header.readUInt16LE(4);
  if (data.length < 6 + size) {
    throw new Error('Incomplete packet');
  }

  const payload = data.slice(6, 6 + size);

  const type = payload.toString('ascii', 0, 2);
  const addressPair = {
    a: payload.readUInt16LE(2),
    b: payload.readUInt16LE(4),
  };

  const packet = {
    type,
    addressPair,
    data: payload.slice(6),
  };

  return packet;
}

  handleZMPacket(packet) {
  const data = packet.data;
  const unknown = data.readUInt32LE(0);
  const compressedPayload = data.slice(4);

  try {
    const compressedData = compressedPayload.slice(2); // Skip first two bytes
    const decompressed = zlib.inflateRawSync(compressedData);
    const jsonStr = decompressed.toString('utf8');

    const jsonData = JSON.parse(jsonStr);
    this.updateChannelStates(jsonData);
    this.updateGlobalStates(jsonData); // Add this line
  } catch (error) {
    this.log('error', `Error decompressing ZM packet data: ${error.message}`);
  }
}


handlePVPacket(packet) {
  const data = packet.data;
  const nameLength = data.length - 4; // Exclude the float value at the end
  const name = data.slice(0, nameLength).toString('utf8').replace(/\0/g, ''); // Remove null bytes
  const val = data.readFloatLE(nameLength);

  // Handle global parameters
  if (name === 'global/mixerBypass') {
    const isBypassed = val > 0;
    this.mixerBypassState = isBypassed;
    this.log('debug', `Mixer Bypass state updated to ${isBypassed} via PV packet`);
    this.checkFeedbacks('mixer_bypass_state'); // Trigger feedback update
    return;
  }

  // Handle channel parameters
  let match = name.match(/^line\/ch(\d+)\/(mute|solo|48v|hpf|pad)$/);
  if (match) {
    const channelNumber = parseInt(match[1], 10);
    const parameter = match[2];
    const isActive = val > 0;

    // Update the specific parameter in the channel state
    this.channelStates[channelNumber] = {
      ...this.channelStates[channelNumber],
      [parameter]: isActive,
    };

    this.log(
      'debug',
      `Channel ${channelNumber} ${parameter} state updated to ${isActive} via PV packet`
    );

    // Trigger feedback updates based on the parameter
    switch (parameter) {
      case 'mute':
        this.log('debug', `Updated channel ${channelNumber} mute state to ${isActive}`);
        this.checkFeedbacks('channel_mute_state');
        break;
      case 'solo':
        this.checkFeedbacks('channel_solo_state');
        break;
      case '48v':
        this.checkFeedbacks('channel_48v_state');
        break;
      case 'hpf':
        this.checkFeedbacks('channel_hpf_state');
        break;
      case 'pad':
        this.checkFeedbacks('channel_pad_state');
        break;
    }

    return;
  }

  // Handle other parameters if necessary
}


updateGlobalStates(jsonData) {
  if (jsonData && jsonData.children && jsonData.children.global) {
    const globalValues = jsonData.children.global.values || {};

    if (globalValues.mixerBypass !== undefined) {
      const isBypassed = globalValues.mixerBypass > 0;
      this.mixerBypassState = isBypassed;
      this.log('debug', `Mixer Bypass state initialized to ${isBypassed}`);
    }
    // Handle other global parameters as needed
  }
}

updateChannelStates(jsonData) {
  if (jsonData && jsonData.children && jsonData.children.line) {
    const lineChildren = jsonData.children.line.children || {};

    for (const [key, channelData] of Object.entries(lineChildren)) {
      const match = key.match(/^ch(\d+)$/);
      if (match && channelData.values) {
        const channelNumber = parseInt(match[1], 10);
        const values = channelData.values;

        // Initialize channel state if not existing
        this.channelStates[channelNumber] = this.channelStates[channelNumber] || {};

        // Update mute state
        if (values.mute !== undefined) {
          this.channelStates[channelNumber].mute = values.mute > 0;
        }

        // Update solo state
        if (values.solo !== undefined) {
          this.channelStates[channelNumber].solo = values.solo > 0;
        }

        // Update 48V state
        if (values['48v'] !== undefined) {
          this.channelStates[channelNumber]['48v'] = values['48v'] > 0;
        }

        // Update HPF state
        if (values.hpf !== undefined) {
          this.channelStates[channelNumber].hpf = values.hpf > 0;
        }

        // Update pad state
        if (values.pad !== undefined) {
          this.channelStates[channelNumber].pad = values.pad > 0;
        }
      }
    }
  }
}

  buildUMPacket(udpPort) {
    const header = Buffer.from('UC\x00\x01', 'ascii');
    const type = Buffer.from('UM', 'ascii');
    const addressPair = Buffer.alloc(4);
    addressPair.writeUInt16LE(0x00, 0); // a=0x00
    addressPair.writeUInt16LE(0x66, 2); // b=0x66

    const portBuffer = Buffer.alloc(2);
    portBuffer.writeUInt16LE(udpPort, 0);

    const payload = Buffer.concat([type, addressPair, portBuffer]);

    const size = Buffer.alloc(2);
    size.writeUInt16LE(payload.length, 0);

    const packet = Buffer.concat([header, size, payload]);

    return packet;
  }

  buildJMPacket() {
    const header = Buffer.from('UC\x00\x01', 'ascii');
    const type = Buffer.from('JM', 'ascii');
    const addressPair = Buffer.alloc(4);
    addressPair.writeUInt16LE(0x68, 0); // a=0x68
    addressPair.writeUInt16LE(0x66, 2); // b=0x66

    const subMsg = {
      id: 'Subscribe',
      clientName: 'Universal Control',
      clientInternalName: 'ucremoteapp',
      clientType: 'iPhone',
      clientDescription: 'iPhone',
      clientIdentifier: 'BE705B5B-ACEC-4941-9ABA-4FB5CA04AC6D',
      clientOptions: '',
      clientEncoding: 23117,
    };

    const subMsgStr = JSON.stringify(subMsg);
    const subMsgBuffer = Buffer.from(subMsgStr, 'utf8');

    const subMsgLength = Buffer.alloc(4);
    subMsgLength.writeUInt32LE(subMsgBuffer.length, 0);

    const payload = Buffer.concat([type, addressPair, subMsgLength, subMsgBuffer]);

    const size = Buffer.alloc(2);
    size.writeUInt16LE(payload.length, 0);

    const packet = Buffer.concat([header, size, payload]);

    return packet;
  }

  buildKAPacket() {
    const header = Buffer.from('UC\x00\x01', 'ascii');
    const type = Buffer.from('KA', 'ascii');
    const addressPair = Buffer.alloc(4);
    addressPair.writeUInt16LE(0x68, 0); // a=0x68
    addressPair.writeUInt16LE(0x66, 2); // b=0x66

    const payload = Buffer.concat([type, addressPair]);

    const size = Buffer.alloc(2);
    size.writeUInt16LE(payload.length, 0);

    const packet = Buffer.concat([header, size, payload]);

    return packet;
  }

  buildPVPacket(name, value) {
    const header = Buffer.from('UC\x00\x01', 'ascii');
    const type = Buffer.from('PV', 'ascii');
    const addressPair = Buffer.alloc(4);
    addressPair.writeUInt16LE(0x68, 0); // a=0x68
    addressPair.writeUInt16LE(0x66, 2); // b=0x66

    const nameBuffer = Buffer.from(name, 'utf8');
    const padding = Buffer.alloc(3, 0x00); // 3 bytes of padding
    const valueBuffer = Buffer.alloc(4);
    valueBuffer.writeFloatLE(value, 0);

    const payload = Buffer.concat([type, addressPair, nameBuffer, padding, valueBuffer]);

    const size = Buffer.alloc(2);
    size.writeUInt16LE(payload.length, 0);

    const packet = Buffer.concat([header, size, payload]);

    return packet;
  }

toggleMixerBypass() {
  const newBypassState = !this.mixerBypassState;
  this.setMixerBypass(newBypassState);
  this.mixerBypassState = newBypassState;
  this.log('info', `Mixer Bypass toggled to ${newBypassState}`);
}

  setMixerBypass(bypass) {
    const packet = this.buildPVPacket('global/mixerBypass', bypass ? 1.0 : 0.0);
    this.sendPacket(packet);
  }

  setChannelMute(channelNumber, mute) {
    const packet = this.buildPVPacket(`line/ch${channelNumber}/mute`, mute ? 1.0 : 0.0);
    this.sendPacket(packet);
  }

  toggleChannelMute(channelNumber) {
    const currentState = this.channelStates[channelNumber];

    if (currentState && typeof currentState.mute === 'boolean') {
      const newMuteState = !currentState.mute;
      this.setChannelMute(channelNumber, newMuteState);
      this.channelStates[channelNumber].mute = newMuteState;
      this.log('info', `Channel ${channelNumber} mute toggled to ${newMuteState}`);
    } else {
      // If we don't know the current state, default to muting
      this.setChannelMute(channelNumber, true);
      this.channelStates[channelNumber] = { mute: true };
      this.log('warn', `Channel ${channelNumber} mute state unknown. Defaulting to mute.`);
    }
      this.log('info', 'Calling checkFeedbacks for channel_mute_state');
      this.checkFeedbacks('channel_mute_state');
  }

  toggleChannelSolo(channelNumber) {
  const currentState = this.channelStates[channelNumber];

  if (currentState && typeof currentState.solo === 'boolean') {
    const newSoloState = !currentState.solo;
    this.setChannelSolo(channelNumber, newSoloState);
    this.channelStates[channelNumber].solo = newSoloState;
    this.log('info', `Channel ${channelNumber} solo toggled to ${newSoloState}`);
  } else {
    // If we don't know the current state, default to soloing
    this.setChannelSolo(channelNumber, true);
    this.channelStates[channelNumber] = { ...currentState, solo: true };
    this.log('warn', `Channel ${channelNumber} solo state unknown. Defaulting to solo.`);
  }
    this.checkFeedbacks('channel_solo_state');
}

  setChannelSolo(channelNumber, solo) {
    const packet = this.buildPVPacket(`line/ch${channelNumber}/solo`, solo ? 1.0 : 0.0);
    this.sendPacket(packet);
  }

  toggleChannel48V(channelNumber) {
    const currentState = this.channelStates[channelNumber];

    if (currentState && typeof currentState['48v'] === 'boolean') {
      const new48VState = !currentState['48v'];
      this.setChannel48V(channelNumber, new48VState);
      this.channelStates[channelNumber]['48v'] = new48VState;
      this.log('info', `Channel ${channelNumber} 48V toggled to ${new48VState}`);
    } else {
      // If we don't know the current state, default to turning 48V off
      this.setChannel48V(channelNumber, false);
      this.channelStates[channelNumber] = { ...currentState, '48v': false };
      this.log('warn', `Channel ${channelNumber} 48V state unknown. Defaulting to off.`);
    }
  }

  setChannel48V(channelNumber, state) {
    const packet = this.buildPVPacket(`line/ch${channelNumber}/48v`, state ? 1.0 : 0.0);
    this.sendPacket(packet);
  }

  toggleChannelHPF(channelNumber) {
    const currentState = this.channelStates[channelNumber];

    if (currentState && typeof currentState.hpf === 'boolean') {
      const newHPFState = !currentState.hpf;
      this.setChannelHPF(channelNumber, newHPFState);
      this.channelStates[channelNumber].hpf = newHPFState;
      this.log('info', `Channel ${channelNumber} HPF toggled to ${newHPFState}`);
    } else {
      // If we don't know the current state, default to turning HPF off
      this.setChannelHPF(channelNumber, false);
      this.channelStates[channelNumber] = { ...currentState, hpf: false };
      this.log('warn', `Channel ${channelNumber} HPF state unknown. Defaulting to off.`);
    }
      this.checkFeedbacks('channel_hpf_state');
  }

  setChannelHPF(channelNumber, state) {
    const packet = this.buildPVPacket(`line/ch${channelNumber}/hpf`, state ? 1.0 : 0.0);
    this.sendPacket(packet);
  }

  toggleChannelPad(channelNumber) {
    const currentState = this.channelStates[channelNumber];

    if (currentState && typeof currentState.pad === 'boolean') {
      const newPadState = !currentState.pad;
      this.setChannelPad(channelNumber, newPadState);
      this.channelStates[channelNumber].pad = newPadState;
      this.log('info', `Channel ${channelNumber} pad toggled to ${newPadState}`);
    } else {
      // If we don't know the current state, default to turning pad off
      this.setChannelPad(channelNumber, false);
      this.channelStates[channelNumber] = { ...currentState, pad: false };
      this.log('warn', `Channel ${channelNumber} pad state unknown. Defaulting to off.`);
    }
      this.checkFeedbacks('channel_pad_state');
  }

  setChannelPad(channelNumber, state) {
    const packet = this.buildPVPacket(`line/ch${channelNumber}/pad`, state ? 1.0 : 0.0);
    this.sendPacket(packet);
  }
}

runEntrypoint(UCControlInstance, []);
