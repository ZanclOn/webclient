// FM IndexedDB layer (using Dexie.js - https://github.com/dfahlander/Dexie.js)
// (indexes and payload are obfuscated using AES ECB - FIXME: use CBC for the payload)

// DB name is fm_ + encrypted u_handle (folder links are not cached yet - FIXME)
// init() checks for the presence of a valid _sn record and wipes the DB if none is found
// pending[] is an array of write transactions that will be streamed to the DB
// setting pending[]._sn opens a new transaction, so always set it last

// - small updates run as a physical IndexedDB transaction
// - large updates are written on the fly, but with the _sn cleared, which
//   ensures integrity, but invalidates the DB if the update can't complete

// plainname: the base name that will be obfuscated using u_k
// schema: the Dexie database schema
// channelmap: { tablename : channel } - tables that do not map to channel 0
// (only channel 0 operates under an _sn-triggered transaction regime)
function FMDB(plainname, schema, channelmap) {
    if (!(this instanceof FMDB)) {
        return new FMDB(plainname, schema, channelmap);
    }

    // DB name suffix, derived from u_handle and u_k
    this.name = false;

    // DB schema - https://github.com/dfahlander/Dexie.js/wiki/TableSchema
    this.schema = schema;

    // the table names contained in the schema
    this.tables = Object.keys(schema);

    // if we have non-transactional (write-through) tables, they are mapped
    // to channel numbers > 0 here
    this.channelmap = channelmap || {};

    // pending obfuscated writes [channel][tid][tablename][action_autoincrement] = [payloads]
    this.pending = [{}];

    // current channel tid being written to (via .add()/.del()) by the application code
    this.head = [0];

    // current channel tid being sent to IndexedDB
    this.tail = [0];

    // -1: idle, 0: deleted sn and writing (or write-through), 1: transaction open and writing
    this.state = -1;

    // [tid, tablename, action] of .pending[] hash item currently being written
    this.inflight = false;

    // the write is complete and needs be be committed (either because of _sn or write-through)
    this.commit = false;

    // a DB error occurred, do not touch IndexedDB for the rest of the session
    this.crashed = false;

    // whether multi-table transactions work (1) or not (0) (Apple, looking at you!)
    this.cantransact = -1;

    // initialise additional channels
    for (var i in obj_values(this.channelmap)) {
        this.head[i] = 0;
        this.tail[i] = 0;
        this.pending[i] = {};
    }

    // protect user identity post-logout
    this.name = ab_to_base64(this.strcrypt((plainname + plainname).substr(0, 16)));
}

// initialise cross-tab access arbitration identity
FMDB.prototype.identity = Date.now() + Math.random().toString(26);

// set up and check fm DB for user u
// calls result(sn) if found and sn present
// wipes DB an calls result(false) otherwise
FMDB.prototype.init = function fmdb_init(result, wipe) {
    var fmdb = this;

    if (!fmdb.up()) result(false);
    else {
        try {
            if (!fmdb.db) {
                var todrop = [];

                // enumerate databases and collect those not prefixed with fm_
                // (which is the current format)
                Dexie.getDatabaseNames(function(r) {
                    for (var i = r.length; i--; ) {
                        if (r[i].substr(0,3) != 'fm_') {
                            todrop.push(r[i]);
                        }
                    }
                }).finally(function(){
                    if (todrop.length) {
                        console.log("Deleting obsolete DBs: " + todrop.join(', '));
                    }

                    fmdb.drop(todrop, function() {
                        // start inter-tab heartbeat
                        fmdb.beacon();
                        fmdb.db = new Dexie('fm_' + fmdb.name);
                        fmdb.db.version(1).stores(fmdb.schema);
                        fmdb.db.open().then(function(){
                            fmdb.get('_sn', function(r){
                                if (!wipe && r[0] && r[0].length == 11) {
                                    console.log("DB sn: " + r[0]);
                                    result(r[0]);
                                }
                                else {
                                    if (d) console.log("No sn found in DB, wiping...");
                                    fmdb.db.delete().then(function(){
                                        fmdb.db.open().then(function(){
                                            result(false);
                                        });
                                    });
                                }
                            });
                        }).catch (Dexie.MissingAPIError, function (e) {
                            fmdb.crashed = true;
                            console.error("IndexedDB unavailable");
                            result(false);
                        }).catch (function (e) {
                            fmdb.crashed = true;
                            console.error(e);
                            result(false);
                        });
                    });
                });
            }
        }
        catch (e) {
            console.error("IndexedDB or crypto layer unavailable, disabling");
            console.log(e);
            fmdb.crashed = true;
            result(false);
        }
    }
};

// drop databases
FMDB.prototype.drop = function fmdb_drop(dbs, cb) {
    if (!dbs || !dbs.length) {
        cb();
    }
    else {
        var fmdb = this;
        var db = dbs.pop();

        (new Dexie(db)).delete().then(function(){
            console.log("Deleted IndexedDB " + db);
        }).catch(function(err){
            console.error("Unable to delete IndexedDB " + db, err);
        }).finally(function(){
            fmdb.drop(dbs, cb);
        });
    }
}

// enqueue a table write - type 0 == addition, type 1 == deletion
// IndexedDB activity is triggered once we have at least 1000 pending rows or the sn
// (writing the sn - which is done last - completes the transaction and starts a new one)
FMDB.prototype.enqueue = function fmdb_enqueue(table, row, type) {
    var fmdb = this;
    var c;
    var ch = fmdb.channelmap[table] || 0;

    // if needed, create new transaction at index fmdb.head
    if (!(c = fmdb.pending[ch][fmdb.head[ch]])) c = fmdb.pending[ch][fmdb.head[ch]] = {};

    // if needed, create new hash of modifications for this table
    // .h = head, .t = tail (last written to the DB)
    if (!c[table]) {
        // even indexes hold additions, odd indexes hold deletions
        c[table] = { t : -1, h : type };
        c = c[table];
    }
    else {
        // (we continue to use the highest index if it is of the requested type
        // unless it is currently in flight)
        // increment .h(head) if needed
        c = c[table];
        if ((c.h ^ type) & 1) c.h++;
    }

    if (!c[c.h]) c[c.h] = [row];
    else c[c.h].push(row);    // add row to the highest index (we want big IndexedDB bulkPut()s)

    // force a flush when a lot of data is pending or the _sn was updated
    // also, force a flush for non-transactional channels (> 0)
    if (ch || table[0] == '_' || c[c.h].length > 65536) {
        // if we have the _sn, the next write goes to a fresh transaction
        if (!ch && table[0] == '_') fmdb.head[ch]++;
        fmdb.writepending(fmdb.head.length-1);
    }
};

// FIXME: auto-retry smaller transactions? (need stats about transaction failures)
// ch - channel to operate on
FMDB.prototype.writepending = function fmdb_writepending(ch) {
    // exit loop if we ran out of pending writes or have crashed
    if (this.inflight || ch < 0 || this.crashed) return;

    // iterate all channels to find pending writes
    if (!this.pending[ch][this.tail[ch]]) return this.writepending(ch-1);

    var fmdb = this;

    if (!ch && fmdb.state < 0 && fmdb.pending[0][fmdb.tail[0]]._sn && fmdb.cantransact) {
        // if the write job is on channel 0 and already complete (has _sn set),
        // we execute it in a single transaction without first clearing sn
        fmdb.state = 1;
        fmdb.db.transaction('rw',
            fmdb.tables,
            function(){
                if (d) console.log("Transaction started");
                fmdb.commit = false;
                fmdb.cantransact = 1;
                dispatchputs();
            }).then(function(){
                // transaction completed: delete written data
                delete fmdb.pending[0][fmdb.tail[0]++];
                fmdb.state = -1;
                if (d) console.log("Transaction committed");
                fmdb.writepending(ch);
            }).catch(function(e){
                if (fmdb.cantransact < 0) {
                    console.error("Your browser's IndexedDB implementation is bogus, disabling transactions.");
                    fmdb.cantransact = 0;
                    fmdb.writepending(ch);
                }
                else {
                    // FIXME: retry instead? need statistics.
                    console.error("Transaction failed, marking DB as crashed");
                    console.log(e);
                    fmdb.state = -1;
                    fmdb.crashed = true;
                }
            });
    }
    else {
        // we do not inject write-through operations into a live transaction
        if (fmdb.state > 0) {
            dispatchputs();
        }
        else {
            // the job is incomplete or non-transactional - set state to "executing
            // write without transaction"
            fmdb.state = 0;

            if (ch) {
                // non-transactional channel: go ahead and write
                dispatchputs();
            }
            else {
                // we clear the sn (the new sn will be written as the last action in this write job)
                // unfortunately, the DB will have to be wiped in case anything goes wrong
                fmdb.db._sn.clear().then(function(){
                    fmdb.commit = false;
                    dispatchputs();
                }).catch(function(e){
                    console.error("SN clearing failed, marking DB as crashed");
                    console.log(e);
                    fmdb.state = -1;
                    fmdb.crashed = true;
                });

            }
        }
    }

    // start writing all pending data in this transaction to the DB
    // conclude/commit the (virtual or real) transaction once _sn has been written
    // FIXME: check if having multiple IndexedDB writes in flight improves performance
    // on Chrome/Firefox/Safari - it kills MSIE
    function dispatchputs() {
        if (fmdb.inflight) return;

        if (fmdb.commit) {
            // the transaction is complete: delete from pending
            if (!fmdb.state) {
                // we had been executing without transaction protection, delete the current
                // transaction and try to dispatch the next one immediately
                if (!ch) delete fmdb.pending[0][fmdb.tail[0]++];

                fmdb.commit = false;
                fmdb.state = -1;
                fmdb.writepending(ch);
            }

            // if we had a real IndexedDB transaction open, it will commit
            // as soon as the browser main thread goes idle
            return;
        }

        var tablesremaining = false;

        // this entirely relies on non-numeric hash keys being iterated
        // in the order they were added. FIXME: check if always true
        for (var table in fmdb.pending[ch][fmdb.tail[ch]]) { // iterate through pending tables, _sn last
            var t = fmdb.pending[ch][fmdb.tail[ch]][table];

            // do we have at least one update pending? (could be multiple)
            if (t[t.h]) {
                tablesremaining = true;

                // locate next pending table update (even/odd: put/del)
                while (t.t <= t.h && !t[t.t]) t.t++;

                // all written: advance head
                if (t.t == t.h) t.h++;

                if (d) console.log("DB " + ((t.t & 1) ? 'del' : 'put') + " with " + t[t.t].length
                                   + " element(s) on table " + table + ", channel " + ch);

                // if we are on a non-transactional channel or the _sn is being updated,
                // request a commit after the operation completes.
                if (ch || table[0] == '_') {
                    fmdb.commit = true;
                }

                // record what we are sending...
                fmdb.inflight = t;

                // ...and send update off to IndexedDB for writing
                fmdb.db[table][t.t & 1 ? 'bulkDelete' : 'bulkPut'](t[t.t++]).then(function(){
                    if (d) console.log('DB write successful' + (fmdb.commit ? ' - transaction complete' : ''));

                    // if we are non-transactional, remove the written data from pending
                    // (we have to keep it for the transactional case because it needs to
                    // be visible to the pending updates search that getbykey() performs)
                    if (!fmdb.state) {
                        delete fmdb.inflight[fmdb.inflight.t++];
                    }

                    // loop back to write more pending data (or to commit the transaction)
                    fmdb.inflight = false;
                    dispatchputs();
                });

                // we don't send more than one transaction (looking at you, Microsoft!)
                return;
            }
            else {
                // if we are non-transactional and all data has been written for this
                // table, we can safely delete its record
                if (!fmdb.state && t.t == t.h) {
                    delete fmdb.pending[ch][fmdb.tail[ch]][table];
                }
            }
        }

        // if we are non-transactional, this deletes the "transaction" when done
        // (as commit will never be set)
        if (!fmdb.state && !tablesremaining) {
            delete fmdb.pending[ch][fmdb.tail[ch]];
        }
    }
};

// encrypt/decrypt UNICODE string s, returns ArrayBuffer
// FIXME: use CBC instead of ECB!
FMDB.prototype.strcrypt = function fmdb_strcrypt(s) {
    var a32 = str_to_a32(to8(s));
    for (var i = (-a32.length) & 3; i--; ) a32.push(0);
    return a32_to_ab(encrypt_key(u_k_aes, a32)).buffer;
};

FMDB.prototype.strdecrypt = function fmdb_strdecrypt(ab) {
    if (!ab.byteLength) return '';
    var a32 = [];
    var dv = new DataView(ab);
    for (var i = ab.byteLength/4; i--; ) a32[i] = dv.getUint32(i*4);
    var s = from8(a32_to_str(decrypt_key(u_k_aes, a32)));
    for (var i = s.length; i--; ) if (s.charCodeAt(i)) return s.substr(0, i+1);
};

// remove fields that are duplicated in or can be inferred from the index to reduce database size
FMDB.prototype.stripnode = Object.freeze({
    f : function(f) {
        var t = { h : f.h, t : f.t, s : f.s };

        delete f.h;
        delete f.t;
        delete f.s;

        if (f.p) {
            t.p = f.p;
            delete f.p;
        }

        if (f.ar) {
            t.ar = f.ar;
            delete f.ar;
        }

        return t;
    },

    s : function(s) {
        var t = { o : s.o, t : s.t };

        delete s.o;
        delete s.t;

        return t;
    },

    attrib : function(attrib, index) {
        delete attrib.k;
    },

    chatqueuedmsgs : function(chatqueuedmsgs, index) {
        delete chatqueuedmsgs.k;
    }
});

// re-add previously removed index fields to the payload object
FMDB.prototype.restorenode = Object.freeze({
    ok : function(ok, index) {
        ok.h = index.h;
    },

    f : function(f, index) {
        f.h = index.h;
        f.p = index.p;
        if (index.s < 0) f.t = -index.s;
        else {
            f.t = 0;
            f.s = parseFloat(index.s);
        }
        if (!f.ar && f.k && typeof f.k == 'object') f.ar = {};
    },

    s : function(f, index) {
        var t = index.o_t.indexOf('*');
        if (t >= 0) {
            f.o = index.o_t.substr(0, t);
            f.t = index.o_t.substr(t + 1);
        }
    },

    ps : function(ps, index) {
        var t = index.h_p.indexOf('*');
        if (t >= 0) {
            ps.h = index.h_p.substr(0, t);
            ps.p = index.h_p.substr(t + 1);
        }
    },

    attrib : function(attrib, index) {
        attrib.k = index.k;
    },

    chatqueuedmsgs : function(chatqueuedmsgs, index) {
        chatqueuedmsgs.k = index.k;
    },

    mk : function(mk, index) {
        mk.h = index.h;
    }
});

// enqueue IndexedDB puts
// sn must be added last and effectively (mostly actually) "commits" the "transaction"
// the next addition will then start a new "transaction"
// (large writes will not execute as an IndexedDB transaction because IndexedDB can't)
FMDB.prototype.add = function fmdb_add(table, row) {
    if (this.crashed) return;

    if (row.d) {
        if (this.stripnode[table]) {
            // this node type is stripnode-optimised: temporarily remove redundant elements
            // to create a leaner JSON and save IndexedDB space
            var d = row.d;  // this references the live object!
            var t = this.stripnode[table](d);   // remove overhead
            row.d = JSON.stringify(d);          // store lean result
            for (var i in t) d[i] = t[i];       // restore overhead
        }
        else {
            // otherwise, just stringify it all
            row.d = JSON.stringify(row.d);
        }
    }

    // obfuscate index elements as base64-encoded strings, payload as ArrayBuffer
    for (var i in row) {
        if (i == 'd') {
            row.d = this.strcrypt(row.d);
        }
        else {
            row[i] = ab_to_base64(this.strcrypt(row[i]));
        }
    }

    this.enqueue(table, row, 0);
};

// enqueue IndexedDB deletions
FMDB.prototype.del = function fmdb_del(table, index) {
    if (this.crashed) return;

    this.enqueue(table, ab_to_base64(this.strcrypt(index)), 1);
};

// non-transactional read with subsequent deobfuscation, with optional prefix filter
// FIXME: replace cb with Promises without incurring a massive readability/mem/CPU penalty!
// (must NOT be used for dirty reads - use getbykey() instead)
FMDB.prototype.get = function fmdb_get(table, cb, key, prefix) {
    if (!this.up()) {
        return cb([]);
    }

    var promise;
    var fmdb = this;

    if (d) console.log("Fetching entire table " + table + "...");

    if (key) promise = fmdb.db[table].where(key).startsWith(prefix).toArray();
    else promise = fmdb.db[table].toArray();

    promise.then(function(r){
        fmdb.normaliseresult(table, r);
        cb(r);
    });
};

FMDB.prototype.normaliseresult = function fmdb_normaliseresult(table, r) {
    var t;

    for (var i = r.length; i--; ) {
        try {
            t = r[i].d ? JSON.parse(this.strdecrypt(r[i].d)) : {};

            if (this.restorenode[table]) {
                // restore attributes based on the table's indexes
                for (var p in r[i]) {
                    if (p != 'd') {
                        r[i][p] = this.strdecrypt(base64_to_ab(r[i][p]));
                    }
                }
                this.restorenode[table](t, r[i]);
            }

            r[i] = t;
        }
        catch (e) {
            console.log(e);
            console.error("IndexedDB corruption: " + this.strdecrypt(r[i].d));
            r.splice(i, 1);
        }
    }
};

// non-transactional read with subsequent deobfuscation, with optional key filter
// FIXME: replace cb with Promises without incurring a massive readability/mem/CPU penalty!
// (dirty reads are supported by scanning the pending writes after the IndexedDB read completes)
// FIXME: do we have a race condition between a write immediately completing after the read?
FMDB.prototype.getbykey = function fmdb_getbykey(table, index, where, cb) {
    if (!this.up()) {
        return cb([]);
    }

    var fmdb = this;
    var ch = fmdb.channelmap[table] || 0;

    if (d) console.log("Fetching table " + table + (where ? (" by keys " + JSON.stringify(where)) : '') + "...");

    var t = fmdb.db[table];
    var i = 0;

    if (where) {
        for (var k = where.length; k--; ) {
            // encrypt the filter values (logical AND is commutative, so we can reverse the order)
            where[k][1] = ab_to_base64(this.strcrypt(where[k][1]));

            // apply filter criterion
            if (i) t = t.and(where[k][0]);
            else {
                t = t.where(where[k][0]);
                i = 1;
            }

            t = t.equals(where[k][1]);
        }
    }

    t.toArray().then(function(r){
        // now scan the pending elements to capture and return unwritten updates
        // FIXME: typically, there are very few or no pending elements -
        // determine if we can reduce overall CPU load by replacing the
        // occasional scan with a constantly maintained hash for direct lookups?
        var matches = {};
        var pendingch = fmdb.pending[ch];
        var tids = Object.keys(pendingch);

        // iterate transactions in reverse chronological order
        for (var ti = tids.length; ti--; ) {
            var tid = tids[ti];
            var t = pendingch[tid][table];

            // any updates pending for this table?
            if (t && t[t.h] && t[t.h].length) {
                // examine update actions in reverse chronological order
                // FIXME: can stop the loop at t.t for non-transactional writes
                for (var a = t.h; a >= 0; a--) {
                    if (t[a]) {
                        if (a & 1) {
                            // deletion - always by bare index
                            var deletions = t[a];

                            for (var j = deletions.length; j--; ) {
                                if (typeof matches[deletions[j]] == 'undefined') {
                                    // boolean false means "record deleted"
                                    matches[deletions[j]] = false;
                                }
                            }
                        }
                        else {
                            // addition or update - index field is attribute
                            var updates = t[a];

                            // iterate updates in reverse chronological order
                            // (updates are not commutative)
                            for (var j = updates.length; j--; ) {
                                var update = updates[j];

                                if (typeof matches[update[index]] == 'undefined') {
                                    // check if this update matches our criteria, if any
                                    if (where) {
                                        for (var k = where.length; k--; ) {
                                            if (update[where[k][0]] !== where[k][1]) break;
                                        }

                                        // mismatch detected - record it as a deletion
                                        if (k >= 0) {
                                            matches[update[index]] = false;
                                            continue;
                                        }
                                    }

                                    matches[update[index]] = update;
                                }
                            }
                        }
                    }
                }
            }
        }

        // scan the result for updates/deletions/additions arising out of the matches found
        for (i = r.length; i--; ) {
            if (typeof matches[r[i][index]] != 'undefined') {
                if (matches[r[i][index]] === false) {
                    // a returned record was deleted or overwritten with
                    // keys that fall outside our where clause
                    r.splice(i, 1);
                }
                else {
                    // a returned record was overwritten and still matches
                    // our where clause
                    r[i] = fmdb.clone(matches[r[i][index]]);
                    delete matches[r[i][index]];
                }
            }
        }

        // now add newly written records
        for (t in matches) {
            if (matches[t]) r.push(fmdb.clone(matches[t]));
        }

        fmdb.normaliseresult(table, r);
        cb(r);
    });
};

// simple/fast/non-recursive object cloning
FMDB.prototype.clone = function fmdb_clone(o) {
    var r = {};

    for (var i in o) r[i] = o[i];

    return r;
};

// checks if crashed or being used by another tab concurrently
FMDB.prototype.up = function fmdb_up() {
    if (this.crashed) return false;

    var state = localStorage[this.name];
    var time = Date.now();

    // another tab was active within the last second?
    if (state) {
        state = JSON.parse(state);

        if (time-state[0] < 1000
        && state[1] !== this.identity) {
            this.crashed = true;
            console.error("*** DISCONNECTING FROM INDEXEDDB - cross-tab interference detected");
            // FIXME: check if mem-only ops are safe at this point, force reload if not
            return false;
        }
    }

    localStorage[this.name] = '[' + time + ',"' + this.identity + '"]';
    return true;
};

// FIXME: improve like this:
// when a new tab is opened with the same session, request an update freeze from the master tab
// once the loading is completed, relinquish update lock
// (we could do this with transactions if Safari supported them properly...)
FMDB.prototype.beacon = function fmdb_beacon() {
    if (this.up()) {
        setTimeout(this.beacon.bind(this), 500);
    }
};
Object.freeze(FMDB.prototype);

// FIXME: remove
var mDBact, mDBv = 7, mDB, mSDB, mSDBPromises = [];

/**
 *  @brief Dynamic wrapper around MegaDB which eases handling
 *         indexedDBs whose purpose is storing plain objects
 *         with no indexes and loaded in bulk at startup.
 *
 *  @param [string]   aName      Database name.
 *  @param [mixed]    aOptions   MegaDB Options (optional)
 *  @param [function] aCallback  Callback to invoke when the db
 *                               is ready to use (optional)
 *
 *  @details The schema is created at runtime by calling the function
 *           addSchemaHandler. If there is no callback provided on the
 *           constructor a mBroadcaster event will be dispatched with
 *           the DB name, ie mStorageDB:dbname, when it's ready to use.
 *           The version is automatically handled by computing a
 *           MurmurHash3 for the schema, and increased as it changes.
 *
 *  @example
 *       mStorageDB('myDataBase', function(aError) {
 *           if (aError) throw new Error('Database error');
 *
 *           this.add('myTable', {
 *               name: 'John Doe', age: 49, car: 'Volvo'
 *           }).then(function() {
 *               console.log('Item inserted successfully');
 *           });
 *       }).addSchemaHandler('myTable', 'name', function(results) {
 *           results.forEach(function(who) {
 *               console.debug('Meet ' + who.name);
 *           })
 *       });
 */
function mStorageDB(aName, aOptions, aCallback) {
    if (!(this instanceof mStorageDB)) {
        return new mStorageDB(aName, aOptions, aCallback);
    }
    if (typeof aOptions === 'function') {
        aCallback = aOptions;
        aOptions = undefined;
    }
    this.name     = aName;
    this.options  = aOptions || {};
    this.handlers = {};
    this.schema   = {};
    mSDBPromises.push(this);
    this.onReadyState = aCallback;

    if (!("plugins" in this.options)) {
        this.options.plugins = MegaDB.DB_PLUGIN.ENCRYPTION;
    }
}
mStorageDB.prototype = {
    addSchema: function mStorageDB_addSchema(aTable, aKeyPath, aIndex) {
        if (Array.isArray(aTable)) {
            var self = this;
            aTable.forEach(function(table) {
                self.addSchema(table, aKeyPath, aIndex);
            });
        }
        else {
            if (!aKeyPath) {
                aIndex = true;
                aKeyPath = 'k';
            }
            this.schema[aTable] = {
                key: {
                    keyPath: aKeyPath
                }
            };

            if (aIndex) {
                this.schema[aTable].indexes = {};
                this.schema[aTable].indexes[aKeyPath] = { unique: true };
            }
        }
        return this;
    },

    addSchemaHandler: function mStorageDB_addSchemaHandler(aTable, aKeyPath, aHandler) {
        this.addSchema(aTable, aKeyPath);
        this.handlers[aTable] = aHandler;
        return this;
    },

    query: function mStorageDB_query(aCommand, aTable, aData) {
        var promise, error;

        if (this.schema[aTable]) {
            if (d) console.log('msdb query', this.name, aCommand, aTable, aData);

            if (aCommand === 'add') {
                promise = this.db.addOrUpdate(aTable, aData);
            }
            else if (aCommand === 'del') {
                promise = this.db.remove(aTable, aData);
            }
            else {
                error = Error("Unknown command '"+aCommand+"'");
            }
        }
        else {
            error = Error("Unknown table '"+aTable+"' for db " + this.name);
        }

        if (error) {
            promise = new MegaPromise();
            Soon(function __msdb_queryError() {
                promise.reject(error);
            });
        }
        return promise;
    },

    setup: function mStorageDB_setup() {
        var promise = new MegaPromise(), self = this, db;

        // MegaDB's encryption plugin depends on u_privk
        if (typeof u_k !== 'undefined' && u_k) {

            db = new MegaDB(this.name, u_handle, this.schema, this.options);

            db.bind('onDbStateReady', function _onDbStateReady() {
                if (self.options.noBulkRead) {
                    return __dbNotifyCompletion();
                }
                self.fetch(Object.keys(self.schema))
                    .then(function() {
                        __dbNotifyCompletion();
                    }, function(err) {
                        __dbNotifyCompletion(err || true);
                    });
            });

            db.bind('onDbStateFailed', function _onDbStateFailed(ev, error) {
                if (d) console.error('onDbStateFailed', error.message || error);
                __dbNotifyCompletion(0xBADF);
            });
        }
        else {
            Soon(__dbNotifyCompletion.bind(null, 0xBADF));
        }

        function __dbNotifyCompletion(aError) {
            if (aError) {
                promise.reject(aError);
            } else {
                promise.resolve(db);
            }
            if (self.onReadyState) {
                Soon(self.onReadyState.bind(self, aError));
                delete self.onReadyState;
            }
            if (db) {
                db.unbind('onDbStateReady').unbind('onDbStateFailed');
            }
            mBroadcaster.sendMessage('mStorageDB:' + self.name, aError);
            promise = db = self = undefined;
        }

        this.db = db;
        this.add = this.query.bind(this, 'add');
        this.del = this.query.bind(this, 'del');

        if (db) {
            this.put = db.put.bind(db);
            this.get = db.getv.bind(db);
            this.cat = db.concat.bind(db);
        }

        return promise;
    },

    fetch: function mStorageDB_fetch(aTables, aPromise) {
        var t = aTables.shift(), self = this;
        if (d) console.log('msdb fetch', t);

        if (!aPromise) {
            aPromise = new MegaPromise();
        }

        if (t) {
            this.db.query(t)
                .execute()
                .then(function _fetchDone(results) {
                    if (d) console.log('msdb fetch done', t, results);

                    if (results.length) {
                        if (self.handlers[t]) {
                            try {
                                self.handlers[t](results, true);
                            }
                            catch(ex) {
                                if (d) console.error(ex);
                            }
                        }
                        else {
                            console.error('No handler for table', t);
                        }
                    }
                    self.fetch(aTables, aPromise);
                }, function _fetchFail() {
                    if (d) console.log('msdb fetch failed', t);
                    aPromise.reject.apply(aPromise, arguments);
                });
        } else {
            aPromise.resolve();
        }

        return aPromise;
    }
};

mBroadcaster.once('startMega', function __idb_setup() {
    try {
        if (!window.indexedDB) {
            window.indexedDB = window.webkitIndexedDB || window.msIndexedDB || window.mozIndexedDB;
            if (!window.indexedDB) {
                throw 1;
            }
        }
    }
    catch (ex) {
        return;
    }
    if (!window.IDBKeyRange) {
        window.IDBKeyRange = window.webkitIDBKeyRange || window.msIDBKeyRange;
    }
    if (!window.IDBTransaction) {
        window.IDBTransaction = window.webkitIDBTransaction || window.OIDBTransaction || window.msIDBTransaction;
    }
    if (indexedDB) {
        mDB = 0x7f;

        if (typeof indexedDB.webkitGetDatabaseNames !== 'function') {
            if (typeof indexedDB.getDatabaseNames === 'function') {
                indexedDB.webkitGetDatabaseNames = indexedDB.getDatabaseNames;
            }
            else {
                indexedDB.webkitGetDatabaseNames = function webkitGetDatabaseNames() {
                    var onsuccess, onerror;
                    var request = Object.create(IDBRequest.prototype, {
                        onsuccess: { set: function(fn) { onsuccess = fn; }},
                        onerror: { set: function(fn) { onerror = fn; }}
                    });

                    Soon(function __getDatabaseNames_polyfill() {
                        try {
                            var length = 0;
                            var list = Object.create(DOMStringList.prototype, {
                                item: { value: function(n) {
                                    return this.hasOwnProperty(n) && this[n] || null;
                                }},
                                contains: { value: function(k) {
                                    return ~Object.getOwnPropertyNames(this).indexOf(k);
                                }},
                                length: { get: function() { return length; }}
                            });

                            for (var i in localStorage) {

                                if (i.substr(0,4) === 'mdb_') {
                                    var idx = i.split('_').pop();

                                    if (idx == 'hash') {
                                        list[length++] = i.substr(0, i.length - 5);
                                    }
                                }
                            }

                            __Notify('success', list);
                        }
                        catch(e) {
                            if (typeof onerror === 'function') {
                                __Notify('error', e);
                            }
                            else {
                                throw e;
                            }
                        }
                    });

                    function __Notify(ev, result) {
                        try {
                            ev = new Event(ev);
                        }
                        catch (ex) { // MSIE
                            ev = { type: ev };
                        }
                        Object.defineProperty(ev, 'target', {value: request});
                        Object.defineProperty(request, 'result', {value: result});

                        if (ev.type === 'error') {
                            onerror(ev);
                        }
                        else {
                            onsuccess(ev);
                        }
                    }

                    return request;
                };
            }
        }
        if (typeof indexedDB.getDatabaseNames !== 'function') {
            indexedDB.getDatabaseNames = indexedDB.webkitGetDatabaseNames;
        }
    }
});

if (0) mBroadcaster.once('startMega', function __msdb_init() {
    var db = new mStorageDB('msmain');

    db.addSchemaHandler('opc',  'p',  processOPC);
    db.addSchemaHandler('ipc',  'p',  processIPC);
    db.addSchemaHandler('ps',   'p',  processPS);
    db.addSchemaHandler('mcf',  'id', processMCF);

    /*mStorageDB('idbcache', { plugins: 0, ersistant: 1 },
        function(aError) {
            if (aError) {
                if (d) {
                    console.warn('Unable to initialize idbcache', aError);
                }
            }
            else {
                Object.defineProperty(mega, 'idbcache', { value: this });
            }
        }).addSchema('fa');*/

    mBroadcaster.once('mStorageDB:' + db.name,
        function __msdb_ready(aError) {
            if (d) console.log('mStorageDB.ready', aError);

            if (aError === 0xBADF) {
                mSDB = db = undefined;
            }
        });

    mBroadcaster.once('mFileManagerDB.done',
        function __msdb_setup(aCallback) {
            function __msdb_done() {
                if (d) console.log('__msdb_done', arguments);

                if (aCallback === getsc) {
                    getsc(1);
                } else {
                    aCallback();
                }
            }
            var promises = mSDBPromises
                .map(function(aDBInstance) {
                    return aDBInstance.setup();
                });
            MegaPromise.all(promises)
                .done(function __msdb_ready(resultPromises) {
                    var requiresReload = resultPromises
                        .some(function(db) {
                            return db.flags & MegaDB.DB_FLAGS.HASNEWENCKEY;
                        });

                    if (requiresReload) {
                        mDBreload();
                    }
                    else {
                        __msdb_done();
                    }
                }).fail(function __msdb_failed(err) {
                    if (d) console.error('__msdb_setup error', err);

                    if (err === 0xBADF) {
                        // error accessing the db, continue with no mSDB support
                        __msdb_done();
                    } else {
                        // error reading db data on disk, force reload
                        mDBreload();
                    }
                }).always(function() {
                    mBroadcaster.sendMessage('mStorageDB!ready');
                });
            mSDBPromises = undefined;
        });

    mBroadcaster.addListener('mFileManagerDB.state',
        function __msdb_state(aState) {
            if (aState === mFileManagerDB.STATE_READONLY) {
                mSDB = undefined;
            } else {
                mSDB = db;
            }
        });
});

var mFileManagerDB = {
    schema: {
        ok: { key: { keyPath: "h"   }},
        u:  { key: { keyPath: "u"   }},
        f:  { key: { keyPath: "h"   }},
        s:  { key: { keyPath: "h_u" }}
    },

    init: function mFileManagerDB_init() {
        var db = new MegaDB("fm", u_handle, this.schema, { murSeed: 0x800F0002 });

        if (mBroadcaster.crossTab.master) {
            var ieAccessError;
            if ("ActiveXObject" in window) {
                db.bind('onDbTransientError', function _onDbTransientError(ev, err) {
                    if (!(db.flags & MegaDB.DB_FLAGS.DBUPGRADE)) {
                        ieAccessError = (Object(err).name === 'InvalidAccessError');
                    }
                });
            }
            db.bind('onDbStateReady', function _onDbStateReady() {
                if (d) console.log('onDbStateReady', arguments);

                var oldVersion = +localStorage['fmdbv_' + u_handle] || this.currentVersion;
                localStorage['fmdbv_' + u_handle] = this.currentVersion;

                if (oldVersion < this.currentVersion && !ieAccessError) {
                    if (d) console.log('fmdb version change');
                    mFileManagerDB.reload();
                }
                else if (+localStorage['fmdblock_' + u_handle]) {
                    if (d) console.log('fmdb is locked');
                    mFileManagerDB.reload();
                }
                else {
                    mDB = this;
                    if (localStorage[u_handle + '_maxaction']) {
                        if (d) console.time('fmdb');
                        mFileManagerDB.fetch(Object.keys(mFileManagerDB.schema));
                    } else {
                        mFileManagerDB._loadfm(this);
                    }
                }
            });
        }
        else {
            db.bind('onDbStateReady', function _onDbStateReady() {
                if (d) {
                    console.log('onDbStateReady.slave', arguments);
                    console.time('fmdb');
                }
                mFileManagerDB.fetch(Object.keys(mFileManagerDB.schema));
            });
            this.slave = true;
        }

        db.bind('onDbStateFailed', function _onDbStateFailed(ev, error) {
            if (d) console.error('onDbStateFailed', error && error.message || error);
            mFileManagerDB._loadfm();
        });

        this.db = db;
        this.state = this.STATE_WORKING;

        this._reset(u_handle);
    },

    fetch: function mFileManagerDB_fetch(aTables) {
        var t = aTables.shift();
        if (d) console.log('fmdb fetch', t);

        if (t) {
            this.db.query(t)
                .execute()
                .then(function _fetchDone(results) {
                    if (d) console.log('fmdb fetch done', t, results);

                    if (!results.length) {
                        mFileManagerDB.fetch(aTables);
                    }
                    else if (t === 'f') {
                        for (var i in results) {
                            if (results[i].sk) {
                                var n = results[i];
                                u_sharekeys[n.h] = crypto_process_sharekey(n.h, n.sk);
                            }
                        }
                        mega.loadReport.recvNodes = Date.now() - mega.loadReport.stepTimeStamp;
                        mega.loadReport.stepTimeStamp = Date.now();

                        $.mDBIgnoreDB = true;
                        process_f(results, function(hasMissingKeys) {
                            delete $.mDBIgnoreDB;
                            if (hasMissingKeys) {
                                srvlog('Got missing keys on DB, forcing fm reload...', null, true);
                                mFileManagerDB.reload();
                            } else {
                                mFileManagerDB.fetch(aTables);
                            }
                        }, 1);
                    }
                    else {
                        if (t === 'ok') {
                            process_ok(results, 1);
                        }
                        else if (t === 'u') {
                            for (var i in results) {
                                M.addUser(results[i], 1);
                            }
                        }
                        else if (t === 's') {
                            for (var i in results) {
                                if (!(results[i].n || results[i].h)) {
                                    console.error('missing required .n property for a nodeShare (mDB init)');
                                } else {
                                    M.nodeShare(
                                        results[i].n ? results[i].n : results[i].h,
                                        results[i],
                                        1
                                    );
                                }
                            }
                        }
                        else {
                            console.error('Unknown table', t);
                        }
                        mFileManagerDB.fetch(aTables);
                    }
                }, function _fetchFail() {
                    if (d) console.log('fmdb fetch failed', t);

                    if (mFileManagerDB.slave) {
                        mFileManagerDB._loadfm();
                    } else {
                        mFileManagerDB._restart();
                    }
                });
        }
        else {
            var hasEntries = false;
            maxaction = localStorage[u_handle + '_maxaction'];

            for (var i in M.d) {
                hasEntries = true;
                break;
            }

            if (d) {
                console.timeEnd('fmdb');
                console.log('fmdb fetch completed', maxaction, hasEntries);
            }

            mega.loadReport.procNodeCount = Object.keys(M.d || {}).length;
            mega.loadReport.procNodes     = Date.now() - mega.loadReport.stepTimeStamp;
            mega.loadReport.stepTimeStamp = Date.now();

            if (!maxaction || !hasEntries) {
                this.reload();
            }
            else {
                this._setstate(this.db);
                mBroadcaster.sendMessage('mFileManagerDB.done', getsc) || getsc(1);
            }
        }
    },

    query: function mFileManagerDB_query(aCommand, aTable, aData) {
        var u_handle = this.userHandle;
        var lock = (parseInt(localStorage['fmdblock_' + u_handle]) | 0) + 1;
        localStorage['fmdblock_' + u_handle] = lock;

        if (!(this.db && this.db.server)) {
            console.warn("No database connection.");
        }
        else if (this.schema[aTable]) {
            var promise;

            if (d /*&& (d > 1 || !(mega.flags & window.MEGAFLAG_EXECSC))*/) {
                console.debug('fmdb query', aCommand, aTable, aData, lock);
            }

            try {
                if (aCommand === 'add') {
                    promise = this.db.server.update(aTable, aData);
                }
                else {
                    promise = this.db.server.remove(aTable, aData);
                }
            }
            catch (ex) {
                console.warn(u_handle, ex);
                return;
            }

            promise.then(function() {
                var l = (+localStorage['fmdblock_' + u_handle] | 0) - 1;
                localStorage['fmdblock_' + u_handle] = l;
                if (d > 1) {
                    console.log('fmdb lock', l);
                }
            });
        } else {
            throw new Error('Unknown fmdb table: ' + aTable);
        }
    },

    exec: function mFileManagerDB_exec(aFunc) {
        var db = this.db, promise = new MegaPromise();

        if (d) console.log('mFileManagerDB.exec', aFunc, db);

        if (db && db.dbState !== MegaDB.DB_STATE.CLOSED) {
            var u_handle = db.suffix;

            if (typeof db[aFunc] === 'function') {
                var expunge = aFunc === 'drop' || aFunc === 'close';

                try {
                    db[aFunc]()
                        .done(function() {
                            promise.resolve();
                        }).fail(function(e) {
                            if (expunge) {
                                localStorage['fmdblock_' + u_handle] = 0xDEAD;
                            }
                            promise.reject(e);
                        });
                } catch(e) {
                    promise.reject(e);
                }

                if (expunge) {
                    this.state = this.STATE_WAITING;
                    delete this.db;
                    this._reset(null);
                }
            }
            else {
                promise.reject('INVALID');
            }
        }
        else {
            promise.reject('CLOSED');
        }

        return promise;
    },

    reload: function mFileManagerDB_reload() {
        if (this.slave) {
            this.exec('close')
                .always(function() {
                    mFileManagerDB._loadfm();
                });
        }
        else if (this.db) {
            this.db.drop()
                .then(function _dropDone() {
                    if (d) console.log('fmdb dropped');
                    mFileManagerDB._restart();
                }, function _dropFail() {
                    if (d) console.log('fmdb drop failed');
                    mFileManagerDB._loadfm();
                });
            delete this.db;
        } else {
            mFileManagerDB._restart();
        }
    },

    _restart: function mFileManagerDB__restart() {
        delete localStorage['fmdblock_' + u_handle];
        delete localStorage[u_handle + '_maxaction'];
        this.init();
    },

    _loadfm: function mFileManagerDB__loadfm(aDBInstance) {

        // dbToNet holds the time wasted trying to read local DB, and having found we have to query the server.
        mega.loadReport.dbToNet = Date.now() - mega.loadReport.startTime;
        mega.loadReport.stepTimeStamp = Date.now();

        this._setstate(aDBInstance);
        mBroadcaster.sendMessage('mFileManagerDB.done', loadfm) || loadfm();
    },

    _reset: function mFileManagerDB__reset(userHandle) {
        if (mFileManagerDB.addQueueTimer
                || mFileManagerDB.delQueueTimer) {

            localStorage['fmdblock_' + this.userHandle] = 0xBADF;

            if (mFileManagerDB.addQueueTimer) {
                delete mFileManagerDB.addQueue;
                delay.cancel(mFileManagerDB.addQueueTimer);
                delete mFileManagerDB.addQueueTimer;
            }

            if (mFileManagerDB.delQueueTimer) {
                delete mFileManagerDB.delQueue;
                delay.cancel(mFileManagerDB.delQueueTimer);
                delete mFileManagerDB.delQueueTimer;
            }
        }
        if (userHandle !== null) {
            this.userHandle = userHandle;
        }
    },

    _setstate: function mFileManagerDB__setstate(aDBInstance) {
        if (!aDBInstance) {
            this.state = this.STATE_FAILED;
            mDB = undefined;
        }
        else if (!mBroadcaster.crossTab.master) {
            if (d) console.log('existing mDB session, read-only mode.');
            this.state = this.STATE_READONLY;
            mDB = undefined;
        }
        else {
            this.state = this.STATE_READY;
            mDB = aDBInstance;
        }
        mBroadcaster.sendMessage('mFileManagerDB.state', this.state);
    },

    state: 0,
    STATE_WAITING:  0,
    STATE_WORKING:  1,
    STATE_READONLY: 2,
    STATE_READY:    4,
    STATE_FAILED:   8
};

function mDBstart(aSlave) {
    switch(mFileManagerDB.state) {
        case mFileManagerDB.STATE_READONLY:
            if (aSlave) {
                mFileManagerDB.
                    _setstate(mFileManagerDB.db);
            }
            break;
        case mFileManagerDB.STATE_WAITING:
            mFileManagerDB.init();
        case mFileManagerDB.STATE_READY:
        case mFileManagerDB.STATE_WORKING:
            if (!aSlave) {
                if (loadfm.loaded) {
                    loadfm();
                }
                else if (is_fm()) {
                    loadingDialog.show();
                }
            }
            break;
        case mFileManagerDB.STATE_FAILED:
            if (!aSlave) {
                loadfm();
            }
        default:
            if (d) console.log('fmdb state', mFileManagerDB.state);
    }
}

function mDBadd(t, a) {
    if (mFileManagerDB.state !== mFileManagerDB.STATE_WORKING
            && mFileManagerDB.state !== mFileManagerDB.STATE_READY) {
        console.warn('Invalid fmdb state', mFileManagerDB.state);
        localStorage['fmdblock_' + u_handle] = 0xBADF;
        return;
    }

    if (a.p !== 'contacts') {
        delete a.ar;
        delete a.name;
    }

    delete a.i; // comes from 't' APs (indicating an index?)
    delete a.key;
    delete a.seen;

    delete a.presence;
    delete a.presenceMtime;

    mDBdel.dispatchTransactionQueue();

    if (!mFileManagerDB.addQueue) {
        mFileManagerDB.addQueue = {};
    }
    if (!mFileManagerDB.addQueue[t]) {
        mFileManagerDB.addQueue[t] = [];
    }
    mFileManagerDB.addQueue[t].push(a);
    mFileManagerDB.addQueueTimer = delay('mDBadd', mDBadd.dispatchTransactionQueue, 300);
}
mDBadd.dispatchTransactionQueue = function() {
    if (mFileManagerDB.addQueueTimer) {
        for (var t in mFileManagerDB.addQueue) {
            if (mFileManagerDB.addQueue.hasOwnProperty(t)) {
                var q = mFileManagerDB.addQueue[t];
                mFileManagerDB.query('add', t, q);
            }
        }
        delete mFileManagerDB.addQueue;
        delay.cancel(mFileManagerDB.addQueueTimer);
        delete mFileManagerDB.addQueueTimer;
    }
};

function mDBdel(t, id) {
    if (mFileManagerDB.state !== mFileManagerDB.STATE_WORKING
            && mFileManagerDB.state !== mFileManagerDB.STATE_READY) {
        console.warn('Invalid fmdb state', mFileManagerDB.state);
        localStorage['fmdblock_' + u_handle] = 0xBADF;
        return;
    }
    mDBadd.dispatchTransactionQueue();

    if (!mFileManagerDB.delQueue) {
        mFileManagerDB.delQueue = {};
    }
    if (!mFileManagerDB.delQueue[t]) {
        mFileManagerDB.delQueue[t] = [];
    }
    mFileManagerDB.delQueue[t].push(id);
    mFileManagerDB.delQueueTimer = delay('mDBdel', mDBdel.dispatchTransactionQueue, 300);
}
mDBdel.dispatchTransactionQueue = function() {
    if (mFileManagerDB.delQueueTimer) {
        for (var t in mFileManagerDB.delQueue) {
            if (mFileManagerDB.delQueue.hasOwnProperty(t)) {
                var q = mFileManagerDB.delQueue[t];
                mFileManagerDB.query('remove', t, q);
            }
        }
        delete mFileManagerDB.delQueue;
        delay.cancel(mFileManagerDB.delQueueTimer);
        delete mFileManagerDB.delQueueTimer;
    }
};

function mDBreload() {
    loadfm.loaded = false;
    mFileManagerDB.reload();
}

function mDBcls() {
    if (Object(window.fmdb).hasOwnProperty('db')) {
        fmdb.db.close();
    }
    fmdb = null;
}
