'use strict';
const assert 					= require('assert');

const payment_channel = require('btc-payment-channel');
const bitcoin 				= require('bitcoinjs-lib');

const request 			  = require('request');

const firewall 				= require('./firewall');
const message 				= require('./protocol').ServerMessage;

const TESTNET_URL 		= 'https://testnet.blockexplorer.com/api/addr/';
const BROADCAST_URL 	= 'https://testnet.blockexplorer.com/api/tx/send';
const UTXO						= '/utxo';
const DAY 						= 60 * 60 * 24;
const BTC 						= 100000000;

// IPTABLES RELATED VALUES
const IPTABLES_IPv4 	= 5;
const IPTABLES_BYTES	= 1;

/**
 * ProviderChannel 
 * An object instance to account for a channel between two nodes.
 * When the channel instance is created, it is assumed that the negotiation is 
 * complete and payment objects are intiailised. 
 *
 * NOTE: Provider Channel should not be accessible from outside PaymentChannelManager!
 * If it is accessible from outside, there's obviously a SERIOUS DESIGN PROBLEM!
 *
 * ARGUMENTS {} object
 * @deposit
 * @clientIP
 * @socket
 * @provider
 * @providerChannelManager
 */
function ProviderChannel(opts) {
	var compulsoryProperties = ['deposit', 'clientIP', 'socket', 'provider', 
		'providerChannelManager'
	];
	compulsoryProperties.forEach(function(p) {
		if (!opts.hasOwnProperty(p)) {
			throw new Error('missing parameter for ProviderChannel : \"' + p + '\"');
		}
	})

	if (!opts.provider instanceof payment_channel.Provider || 
		  !opts.providerChannelManager instanceof ProviderChannelManager) 
	{
		throw new Error('strict type error');
	}

	this._clientBalance = opts.deposit;
	this._clientDeposit = opts.deposit;	
	this._clientIP = opts.clientIP;
	this._provider = opts.provider;
	this.manager  = opts.providerChannelManager;

	this._socket = opts.socket;

	// payment information
	this._latestInvoice = null;
	this._totalUsageInKB = 0;
	this._paidUsageInKB = 0;

	// btc payment channel stuff
	this._paymentTx = null;
	this._fundingToggle = false;
}

/**
 * Process Commitment Tx Hashes
 * 
 */
ProviderChannel.prototype.processCommitment = function(commitmentMsg) {
	var tx = bitcoin.Transaction.fromHex(commitmentMsg.commitmentTx);
	var self = this;
	if (tx.outs[0].value !== this._clientDeposit) {
		this._socket.emit('channel', message.InvalidCommitment());
		throw new Error('commitmentTx does not match claimed deposit obligation');
	} else {
		request
		.post({
			url : BROADCAST_URL,
			form : { rawtx : commitmentMsg.commitmentTx }
		})
		.on('data', function(chunk) {
			firewall.approveFilter(self._clientIP);
			self._fundingToggle = true;
			self._socket.emit('channel', message.ValidCommitment());
		});
	}
}

ProviderChannel.prototype.processRefund = function(refundTxHash) {
	this._provider.signRefundTx(refundTxHash);
	var socket = this._socket;
	this._provider.sendRefundTx(function(signedRefundTx) {
		socket.emit('channel', message.SignedRefund(signedRefundTx));
	});
}

/**
 * Process Payment
 * 
 * processes payment from a consumer 
 */
ProviderChannel.prototype.processPayment = function(payment) {
	try {
		this._provider.checkAndSignPaymentTx(payment, this._latestInvoice.totalPaidAmount);
		console.log('payment received');
		assert(this._provider.paymentTx !== null);
	} catch (err) {
		console.log('Invalid PaymentTx received from Consumer: ' + err);
		this.issueInvoice();
	}
	this._clientBalance = this._clientDeposit - this._latestInvoice.newPayAmount;
	this._latestInvoice = null;
}

/**
 * Issues an invoice and sends it to the consumer channel handler.
 *
 */
ProviderChannel.prototype.issueInvoice = function() {
	// latest invoice will only be wiped clean if it is paid properly! otherwise
	// the old timestamp will stick until the channel gets TORN DOWN.

	if (this._clientBalance < (this._totalUsageInKB * this.manager._pricePerKB)) {
		this.manager.teardown(this._clientIP);
	}

	if (!this._fundingToggle) {
		console.log('channel not fully funded yet');
		return;
	}

	if (this._totalUsageInKB === this._paidUsageInKB) {
		console.log('invoice cycle skipped.');
		return;
	}

	var d = Math.round((new Date().getTime()) / 1000);

	if (this._latestInvoice) {

		if ((d - this._latestInvoice.time) > this.manager._warningTime) {
			console.log('channel torn down for failing to make payment');
			this.manager.tearDown(this._clientIP);
			return;
		}

		this._latestInvoice = new message.Invoice({
			incrementAmount : (this._totalUsageInKB - this._paidUsageInKB) * this.manager._pricePerKB,
			totalPaidAmount : this._totalUsageInKB  * this.manager._pricePerKB,
			usage : this._totalUsageInKB - this._paidUsageInKB,
			totalUsage : this._totalUsageInKB,
			pricePerKB : this.manager._pricePerKB,
			time : this._latestInvoice.time
		});
	} else {
		this._latestInvoice = new message.Invoice({
			incrementAmount : (this._totalUsageInKB - this._paidUsageInKB) * this.manager._pricePerKB,
			totalPaidAmount : this._totalUsageInKB  * this.manager._pricePerKB,
			usage : this._totalUsageInKB - this._paidUsageInKB,
			totalUsage : this._totalUsageInKB,
			pricePerKB : this.manager._pricePerKB,
			time : d
		});
	}
	var invoice = {
		type : 'invoice',
		invoice : this._latestInvoice
	};

	this._socket.emit('channel', invoice);
	console.log('invoice issued to ' + this._clientIP);
}

/**
 * Teardown Message 
 *
 * Only sent when a channel is abruptly torn down by the Provider.
 * Payments are disregarded and everything ends abruptly.
 */
ProviderChannel.prototype.tearDown = function() {
	console.log('channel torn down');
	this.manager.removeChannel(this._clientIP);
	this._provider.broadcastPaymentTx(function(paymentTx) {
		request
		.post({
			URL : BROADCAST_URL,
			form : { rawtx : paymentTx }
		})
		.on('data', function(chunk) {
			console.log('TEARDOWN :: paymentTx broadcasted, txId : ' + JSON.parse(chunk.toString('utf8')).toString());
		})
	});
	this._socket.emit('channel', {
		type : 'teardown'
	});
	// revoke firewall privilleges
}

/**
 * Shutdown Message
 *
 * Only sent when a Biternet Node needs to be shut down. 
 * Final payments are expected and the Node will process final payments prior
 * to closing down a channel.
 */
ProviderChannel.prototype.shutDown = function() {
	var ipaddr = this._clientIP;
	this._provider.broadcastPaymentTx(function(paymentTx) {
		request
		.post({
			URL : BROADCAST_URL,
			form : { rawtx : paymentTx }
		})
		.on('data', function(chunk) {
			console.log('SHUTDOWN :: paymentTx broadcasted, txId : ' + JSON.parse(chunk.toString('utf8')).toString());
		})
	});
	console.log(ipaddr);
	firewall.removeFilter(ipaddr);
	this._socket.emit('channel', {
		type : 'shutdown'
	});
	// revoke firewall privilleges
}

ProviderChannel.prototype.updateUsage = function(bytes) {
	this._totalUsageInKB = Math.round(bytes / 1024);
}

/**
 * Provider Channel Manager
 * An object instance dedicated to channel management, creation and all things 
 * related to channels.
 *
 * ARGUMENT {} object
 * @paymentAddress, 										paymentAddress for bitcoin transactions
 * @keyPairWIF, 												WIF export format for private key 
 																				generation using bitcoinjs-lib
 * @pricePerKB [OPTIONAL], 							price per kB in satoshis
 * @minDeposit [OPTIONAL], 							btc amount in satoshis
 * @chargeInterval [OPTIONAL], 					charging interval in seconds
 * @minTimeLockDuration [OPTIONAL], 		the min. timelock duration the provider 
 																				instance is willing to accept (in seconds)
 * @warningAmountThreshold [OPTIONAL], 	the threshold for an event to be emitted
 * @warningTime [OPTIONAL],							amount of time provided to client to 
 																				resolve warnings
 * @network, OPTIONAL. 
 */
function ProviderChannelManager(opts) {
	var compulsoryProperties = ['paymentAddress', 'keyPairWIF'];
	compulsoryProperties.forEach(function(p) {
		if(!opts.hasOwnProperty(p)) {
			throw new Error('missing parameter for Channel Manager : \"' + p + '\"');
		}
	})

	this._network = opts.network ? opts.network : bitcoin.networks.testnet;

	/** test the addresses **/
	bitcoin.address.toOutputScript(opts.paymentAddress, this._network);

	this._paymentAddress = opts.paymentAddress;

	this._warningAmountThreshold = opts.warningAmountThreshold ? 
		opts.warningAmountThreshold : 1000;
	this._warningTime = opts.warningTime ? opts.warningTime : 60;
	this._pricePerKB = opts.pricePerKB ? opts.pricePerKB : 2;
	this._minDeposit = opts.minDeposit ? opts.minDeposit : 225000; 
	this._chargeInterval = opts.chargeInterval ? opts.chargeInterval : 5;
	this._minTimeLockDuration = opts.minTimeLockDuration ? 
		opts.minTimeLockDuration : DAY;

	if (!opts.keyPairWIF instanceof String) {
		throw new Error('wrong type for keyPairWIF. Must be type String');
	}
	this._keyPair = bitcoin.ECPair.fromWIF(opts.keyPairWIF, this._network);

	/** non-init stuff **/
	this._pollingList = []; // object returned by setInterval. polling IpTables
	this._channels = [];

	// issue invoices for payments 
	var self = this;
	this.initFirewall();
	this._pollingList.push(setInterval(function() {
		self.collectPayment();
	}, this._chargeInterval * 1000));
}

/**
 * Channel builder
 *
 */
ProviderChannelManager.prototype.startChannel = function(ipaddr, socket, clientDetails) {
	var newChannel = new ProviderChannel({
		clientIP : ipaddr,
		deposit : clientDetails.deposit,
		socket : socket,
		refundTxHash : clientDetails.refundTxHash,
		provider : new payment_channel.Provider({
			providerKeyPair : this._keyPair,
			consumerPubKey : new Buffer(clientDetails.consumerPubKey, 'hex'),
			refundAddress : clientDetails.refundAddress,
			paymentAddress : this._paymentAddress,
			network : this._network
		}),
		providerChannelManager : this
	})
	this._channels[ipaddr] = newChannel;
	newChannel.processRefund(clientDetails.refundTxHash);
	console.log('channel started...');
}

/** 
 * returns the advertisement JSON object for a Provider
 */
ProviderChannelManager.prototype.getAdvertisement = function() {
	return {
		type : 'advertisement',
		coin_network : this._network,
		paymentAddress : this._paymentAddress,
		serverPublicKey : this._keyPair.getPublicKeyBuffer().toString('hex'),
		pricePerKB : this._pricePerKB,
		warningAmountThreshold : this._warningAmountThreshold,
		minDeposit : this._minDeposit,
		chargeInterval : this._chargeInterval,
		minTimeLockDuration : this._minTimeLockDuration
	};
}

/** 
 * 
 */
ProviderChannelManager.prototype.collectPayment = function() {
	if (Object.keys(this._channels).length > 0) {
		console.log('reading IP Accounting Tables...');
		this.readDownUsage();
		console.log('issuing invoices for payments...');
		for (var c in this._channels) {
			this._channels[c].issueInvoice();
		}
	} else {
		console.log('no channels to collect payments from...');
	}
}

/** 
 * Processes payment for a particular channel
 *
 * ARGUMENTS
 * @ipaddr (STRING), remote ip address of the client socket
 * @payment (STRING: paymentTxHash), payment transaction hash 
 */
ProviderChannelManager.prototype.processPayment = function(ipaddr, payment) {
	this._channels[ipaddr].processPayment(payment);
}

/** 
 * Processes a commitment transaction
 */
ProviderChannelManager.prototype.processCommitment = function(ipaddr, commitment) {
	this._channels[ipaddr].processCommitment(commitment);
}

/** 
 * Tears down a channel given by the remote IP address of a socket.
 *
 * ARGUMENTS
 * @ipaddr (STRING), remote ip address of the client socket
 */
ProviderChannelManager.prototype.tearDown = function(ipaddr) {
	this._channels[ipaddr].tearDown();
	delete this._channels[ipaddr];
}

ProviderChannelManager.prototype.initFirewall = function() {
	firewall.applyForwardFiltering();
}

ProviderChannelManager.prototype.flushFirewall = function() {
	firewall.undoForwardFiltering();
}

ProviderChannelManager.prototype.readDownUsage = function() {
	var downTable = firewall.readDownAcct();
	console.log(downTable);
	var self = this;
	downTable.forEach(function(e) {
		console.log(e);
		if (e !== null) {
			self._channels[e[IPTABLES_IPv4]].updateUsage(parseInt(e[IPTABLES_BYTES]));
		}
	})
}

ProviderChannelManager.prototype.readUpUsage = function() {

}

ProviderChannelManager.prototype.removeChannel = function(ipaddr) {
	delete this._channels[ipaddr];
}

ProviderChannelManager.prototype.processShutdown = function(ipaddr) {
	this._channels[ipaddr].shutDown();
	delete this._channels[ipaddr];
}

/**
 * Shuts down the ProviderChannelManager
 */
ProviderChannelManager.prototype.shutdown = function() {
	this._pollingList.forEach(function(p) {
		clearInterval(p);
	});
	this.collectPayment();
	this._channels.forEach(function(c) {
		c.shutdown();
	})
	this.flushFirewall();
}

module.exports = ProviderChannelManager;
