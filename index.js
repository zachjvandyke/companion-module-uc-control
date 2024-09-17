// index.js
const { InstanceBase, TCPHelper, runEntrypoint, Regex } = require('@companion-module/base');
const net = require('net');
const dgram = require('dgram');
const zlib = require('zlib');

class UCControlInstance extends InstanceBase {
  constructor(internal) {
    super(internal);

    this.config = {};
    this.tcpClient = null;
    this.udpServer = null;
    this.udpPort = null;
    this.heartbeatInterval = null;
    this.receiveBuffer = Buffer.alloc(0);
  }

  async init(config) {
    this.config = config;

    this.updateStatus('connecting');

    this.initTCP();
    this.initUDP();

    this.initActions();

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
        // After TCP connection is established, send subscription messages
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
          max: 64,
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

    this.setActionDefinitions(actions);
  }

  sendPacket(packet) {
    if (this.tcpClient && !this.tcpClient.destroyed) {
      this.tcpClient.write(packet);
    } else {
      this.log('error', 'TCP client is not connected');
    }
  }

  handleIncomingData(data) {
    // Handle incoming TCP data if necessary
    this.log('debug', `Received TCP data: ${data.toString('hex')}`);
    // You can implement packet parsing here if needed
  }

  handleIncomingUDPData(data) {
    // Handle incoming UDP data
    this.log('debug', `Received UDP data: ${data.toString('hex')}`);
    // You can implement packet parsing here if needed
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
    addressPair.writeUInt16LE(0x6a, 2); // b=0x6a

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
    addressPair.writeUInt16LE(0x6a, 2); // b=0x6a

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
    addressPair.writeUInt16LE(0x6a, 2); // b=0x6a

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

  setMixerBypass(bypass) {
    const packet = this.buildPVPacket('global/mixerBypass', bypass ? 1.0 : 0.0);
    this.sendPacket(packet);
  }

  setChannelMute(channelNumber, mute) {
    const packet = this.buildPVPacket(`line/ch${channelNumber}/mute`, mute ? 1.0 : 0.0);
    this.sendPacket(packet);
  }
}

runEntrypoint(UCControlInstance, []);
