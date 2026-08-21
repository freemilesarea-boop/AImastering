// Loads the built addon, or throws so `loadAuHost()` records "no AU hosting".
//
// The throw is the interface: every failure here — not built, wrong arch,
// blocked by library validation — means the same thing to the caller, and it
// already treats all of them the same way.
module.exports = require('./build/Release/au_host.node');
