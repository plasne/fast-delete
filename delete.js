
// includes
require("dotenv").config();
const winston = require("winston");
const cmd = require("commander");
const xpath = require("xpath");
const dom = require("xmldom").DOMParser;
const request = require("request");
const agentKeepAlive = require("agentkeepalive");
const querystring = require("query-string");
const crypto = require("crypto");
const promisePool = require("es6-promise-pool");
const readline = require("readline");
const lsof = require("lsof");

// prototype extensions
String.prototype.replaceAll = function (search, replacement) {
    var target = this;
    return target.replace(new RegExp(search, "g"), replacement);
};

// define command line parameters
cmd
    .version("0.1.0")
    .option("-l, --log-level <s>", `LOG_LEVEL. The minimum level to log to the console (error, warn, info, verbose, debug, silly). Defaults to "info".`, /^(error|warn|info|verbose|debug|silly)$/i)
    .option("-a, --account <s>", `STORAGE_ACCOUNT. Required. The name of the Azure Storage Account.`)
    .option("-c, --container <s>", `STORAGE_CONTAINER. Required. The name of the Azure Storage Account Container.`)
    .option("-s, --sas <s>", `STORAGE_SAS. The Shared Access Signature querystring.`)
    .option("-k, --key <s>", `STORAGE_KEY. The Azure Storage Account key.`)
    .option("-p, --prefix <s>", `PREFIX. Specify to only delete blobs with this prefix. Ex. "20180101T000000/input".`)
    .option("-m, --mode <s>", `MODE. Can be "delete" or "test" (just shows what would be deleted). Defaults to "test".`)
    .option("-x, --concurrency <i>", `CONCURRENCY. The number of delete operations to perform at a time. Defaults to "100".`, parseInt)
    .option("-e, --on-error <s>", `ON_ERROR. Can be "halt" or "continue". Default is "halt".`)
    .option("-r, --retries <i>", `RETRIES. You can specify a number of times to retry the deletion. Default is "0".`, parseInt)
    .parse(process.argv);

// globals
const LOG_LEVEL = cmd.logLevel || process.env.LOG_LEVEL || "info";
const STORAGE_ACCOUNT = cmd.account || process.env.STORAGE_ACCOUNT;
const STORAGE_CONTAINER = cmd.container || process.env.STORAGE_CONTAINER;
const STORAGE_SAS = cmd.sas || process.env.STORAGE_SAS;
const STORAGE_KEY = cmd.key || process.env.STORAGE_KEY;
const PREFIX = cmd.prefix || process.env.PREFIX;
const MODE = cmd.mode || process.env.MODE || "test";
let CONCURRENCY = cmd.concurrency || process.env.CONCURRENCY || 100;
CONCURRENCY = parseInt(CONCURRENCY);
if (isNaN(CONCURRENCY)) CONCURRENCY = 100;
const ON_ERROR = cmd.onError || process.env.ON_ERROR || "halt";
let RETRIES = cmd.retries || process.env.RETRIES || 0;
RETRIES = parseInt(RETRIES);
if (isNaN(RETRIES)) RETRIES = 100;

// enable logging
const logColors = {
    "error": "\x1b[31m", // red
    "warn": "\x1b[33m", // yellow
    "info": "",         // white
    "verbose": "\x1b[32m", // green
    "debug": "\x1b[32m", // green
    "silly": "\x1b[32m"  // green
};
const logger = winston.createLogger({
    level: LOG_LEVEL,
    transports: [
        new winston.transports.Console({
            format: winston.format.combine(
                winston.format.timestamp(),
                winston.format.printf(event => {
                    const color = logColors[event.level] || "";
                    const level = event.level.padStart(7);
                    if (event.coorelationId) {
                        return `${event.timestamp} ${color}${level}\x1b[0m ${event.coorelationId}: ${event.message}`;
                    } else {
                        return `${event.timestamp} ${color}${level}\x1b[0m: ${event.message}`;
                    }
                })
            )
        })
    ]
});

// log startup
console.log(`LOG_LEVEL set to "${LOG_LEVEL}".`);
logger.info(`STORAGE_ACCOUNT = "${STORAGE_ACCOUNT}".`);
logger.info(`STORAGE_CONTAINER = "${STORAGE_CONTAINER}".`);
logger.info(`STORAGE_KEY is ${(STORAGE_KEY) ? "defined" : "undefined"}.`);
logger.info(`STORAGE_SAS is ${(STORAGE_SAS) ? "defined" : "undefined"}.`);
if (PREFIX) logger.info(`PREFIX = "${PREFIX}".`);
logger.info(`MODE = "${MODE}".`);
logger.info(`CONCURRENCY = "${CONCURRENCY}".`);
logger.info(`ON_ERROR = "${ON_ERROR}".`);
logger.info(`RETRIES = "${RETRIES}".`);

// check requirements
if (!STORAGE_ACCOUNT) throw new Error("You must specify STORAGE_ACCOUNT in either .env or command line.");
if (!STORAGE_CONTAINER) throw new Error("You must specify STORAGE_CONTAINER in either .env or command line.");
if (!STORAGE_KEY && !STORAGE_SAS) throw new Error("You must specify either STORAGE_KEY or STORAGE_SAS in either .env or command line.");

// use an HTTP(s) agent with keepalive and connection pooling
const agent = new agentKeepAlive.HttpsAgent({
    maxSockets: CONCURRENCY + 50,
});

function generateSignature(path, options) {

    // pull out all querystring parameters so they can be sorted and used in the signature
    const parameters = [];
    const parsed = querystring.parseUrl(options.url);
    for (const key in parsed.query) {
        parameters.push(`${key}:${parsed.query[key]}`);
    }
    parameters.sort((a, b) => a.localeCompare(b));

    // pull out all x-ms- headers so they can be sorted and used in the signature
    const xheaders = [];
    for (const key in options.headers) {
        if (key.substring(0, 5) === "x-ms-") {
            xheaders.push(`${key}:${options.headers[key]}`);
        }
    }
    xheaders.sort((a, b) => a.localeCompare(b));

    // zero length for the body is an empty string, not 0
    const len = (options.body) ? Buffer.byteLength(options.body) : "";

    // potential content-type, if-none-match
    const ct = options.headers["Content-Type"] || "";
    const none = options.headers["If-None-Match"] || "";

    // generate the signature line
    let raw = `${options.method}\n\n\n${len}\n\n${ct}\n\n\n\n${none}\n\n\n${xheaders.join("\n")}\n/${STORAGE_ACCOUNT}/${STORAGE_CONTAINER}`;
    if (path) raw += `/${path}`;
    raw += (parameters.length > 0) ? `\n${parameters.join("\n")}` : "";
    logger.log("debug", `The unencoded signature is "${raw.replaceAll("\n", "\\n")}"`);

    // sign it
    const hmac = crypto.createHmac("sha256", new Buffer.from(STORAGE_KEY, "base64"));
    const signature = hmac.update(raw, "utf-8").digest("base64");

    // return the Authorization header
    return `SharedKey ${STORAGE_ACCOUNT}:${signature}`;

}

function deleteBlob(filename) {
    return new Promise((resolve, reject) => {
        logger.log("debug", `starting delete of "${filename}"...`);

        // specify the request options, including the headers
        const options = {
            method: "DELETE",
            agent: agent,
            url: `https://${STORAGE_ACCOUNT}.blob.core.windows.net/${STORAGE_CONTAINER}/${filename}${STORAGE_SAS || ""}`,
            headers: {
                "x-ms-version": "2017-07-29",
                "x-ms-date": (new Date()).toUTCString(),
                "x-ms-delete-snapshots": "include"
            }
        };

        // generate and apply the signature
        if (!STORAGE_SAS) {
            const signature = generateSignature(filename, options);
            options.headers.Authorization = signature;
        }

        // execute
        request(options, (error, response) => {
            if (!error && response.statusCode >= 200 && response.statusCode < 300) {
                logger.log("debug", `deleted "${filename}".`);
                resolve();
            } else if (error) {
                logger.error(`failed to delete "${filename}${(response && response.statusCode) ? " (HTTP: " + response.statusCode + ")" : ""}": ${error}`);
                reject(error);
            } else {
                logger.error(`failed to delete "${filename}": ${response.statusCode}: ${response.statusMessage}`);
                reject(new Error(`${response.statusCode}: ${response.statusMessage}`));
            }
        });

    });
}

function listBlobs(marker) {
    return new Promise((resolve, reject) => {

        // log start
        if (PREFIX) {
            logger.log("debug", `getting another batch of blobs prefixed by "${PREFIX}"...`);
        } else {
            logger.log("debug", `getting another batch of blobs...`);
        }

        // query for 5,000 blobs by prefix
        const options = {
            method: "GET",
            agent: agent,
            url: `https://${STORAGE_ACCOUNT}.blob.core.windows.net/${STORAGE_CONTAINER}${(STORAGE_SAS) ? STORAGE_SAS + "&" : "?"}restype=container&comp=list${(PREFIX) ? "&prefix=" + PREFIX : ""}${(marker) ? "&marker=" + marker : ""}`,
            headers: {
                "x-ms-version": "2017-07-29",
                "x-ms-date": (new Date()).toUTCString()
            }
        };

        // generate and apply the signature
        if (!STORAGE_SAS) {
            const signature = generateSignature(null, options);
            options.headers.Authorization = signature;
        }

        // execute
        request(options, (error, response, body) => {
            if (!error && response.statusCode >= 200 && response.statusCode < 300) {

                // parse XML response
                const doc = new dom().parseFromString(body);

                // extract the filenames
                const filenames = [];
                for (blob of xpath.select("/EnumerationResults/Blobs/Blob", doc)) {
                    const filename = xpath.select1("string(Name)", blob);
                    filenames.push(filename);
                    logger.log("debug", `"${filename}" identified for deletion.`);
                }

                // get the next marker
                const next = xpath.select1("string(/EnumerationResults/NextMarker)", doc);
                if (next) {
                    logger.log("debug", `there are more blobs to fetch.`)
                } else {
                    logger.log("debug", `all block blobs were fetched.`)
                }

                // resolve
                resolve({
                    filenames: filenames,
                    marker: next
                });

            } else if (error) {
                logger.error(`failed to list block blobs (prefix: "${PREFIX}")${(response && response.statusCode) ? " (HTTP: " + response.statusCode + ")" : ""}": ${error}`);
                reject(error);
            } else {
                logger.error(`failed to list block blobs (prefix: "${PREFIX}")": ${response.statusCode}: ${response.statusMessage}`);
                reject(new Error(`${response.statusCode}: ${response.statusMessage}`));
            }
        });

    });
}

// perform a test
if (MODE.toLowerCase() === "test") {
    let count = 0;
    const fetch = async (marker) => {
        try {
            const results = await listBlobs(marker);
            for (const filename of results.filenames) {
                logger.info(filename);
                count++;
            }
            if (results.marker) {
                setTimeout(() => { fetch(results.marker); }, 0);
            } else {
                logger.log(`${count} blob(s) would have been deleted.`);
            }
        } catch (error) {
            logger.error(`There was a fatal error. Program aborting.`);
            logger.error(error.stack);
            process.exit(1);
        }
    }
    setTimeout(() => { fetch(); }, 0);
}

// perform a delete
if (MODE.toLowerCase() === "delete") {
    let start = new Date();
    let count = 0;
    let retries = 0;
    let mode = "initializing";
    const buffer = [];

    // fetch a list of blobs
    const fetch = async (marker) => {
        try {

            // if the buffer gets too big, wait for a bit
            if (buffer.length > 50000) {
                logger.verbose(`waiting for the buffer to empty some...`);
                setTimeout(() => { fetch(marker); }, 1000);
                return;
            }

            // start fetching
            mode = "fetching";
            const results = await listBlobs(marker);

            // add to the buffer
            for (const filename of results.filenames) {
                buffer.push(filename);
            }

            // keep fetching if needed
            if (results.marker) {
                mode = "waiting";
                setTimeout(() => { fetch(results.marker); }, 0);
            } else {
                mode = "done";
            }

        } catch (error) {
            logger.error(`There was a fatal error. Program aborting after ${count} deleted.`);
            logger.error(error.stack);
            process.exit(1);
        }
    }

    // build a producer of delete promises
    const producer = () => {
        if (buffer.length > 0) {
            // delete next
            const filename = buffer.pop();
            return deleteBlob(filename).then(_ => {
                count++;
            }).catch(error => {
                if (ON_ERROR.toLowerCase() === "continue") {
                    logger.error(`There was an error deleting "${filename}", but we will continue.`);
                    logger.error(error.stack);
                } else {
                    logger.error(`There was a fatal error. Program aborting after ${count} deleted.`);
                    logger.error(error.stack);
                    process.exit(1);
                }
            });
        } else if (mode !== "done") {
            // delay for 1 second, hopefully there will be more in the buffer
            logger.verbose(`waiting on buffer to refill...`);
            return new Promise(resolve => setTimeout(resolve, 1000));
        } else {
            // we are done
            return undefined;
        }
    }

    // handle done or terminate
    const progress = () => {
        lsof.counters(counters => {
            const now = new Date();
            const elapsed = (now - start) / 1000;
            if (count > 0) {
                logger.info(`${count} blob(s) deleted after ${(elapsed / 60).toFixed(2)} minutes, ${Math.round(count / elapsed)}/sec, file desc: ${counters.open}.`);
            } else {
                logger.info(`${count} blob(s) deleted after ${(elapsed / 60).toFixed(2)} minutes, file desc: ${counters.open}.`);
            }
        });
    };

    // start with fetch and then delete
    setTimeout(async () => {

        // fetch, delete, retry
        do {

            // fetch another set
            mode = "waiting";
            await fetch();

            // reset counters
            start = new Date();
            count = 0;

            // start showing progress
            const i = setInterval(progress, 1000);

            // start the cycle
            const pool = new promisePool(producer, CONCURRENCY);
            await pool.start();
            logger.info(`delete operation completed`);
            progress();

            // stop showing progress
            clearInterval(i);

            // retry
            retries++;
            if (retries <= RETRIES) logger.info(`beginning retry attempt ${retries}.`);

        } while (retries <= RETRIES)

    }, 0);

    // gracefully shutdown
    process.on("SIGINT", () => {
        readline.clearLine(process.stdout, 0);
        readline.cursorTo(process.stdout, 0);
        logger.info(`user terminated the execution.`);
        progress();
        process.exit(0);
    });

}
