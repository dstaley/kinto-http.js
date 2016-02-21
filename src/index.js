"use strict";

import "isomorphic-fetch";
import { EventEmitter } from "events";

import { quote, unquote, partition, pMap } from "./utils.js";
import HTTP from "./http.js";
import endpoint from "./endpoint";
import * as requests from "./requests";
import { createBatch, aggregate } from "./batch";
import { Bucket } from "./chain";


/**
 * Currently supported protocol version.
 * @type {String}
 */
export const SUPPORTED_PROTOCOL_VERSION = "v1";

/**
 * High level HTTP client for the Kinto API.
 *
 * @example
 * const client = new KintoClient("https://kinto.dev.mozaws.net/v1");
 * client.createRecord("my-blog", {title: "First article"})
 *   .then(console.log.bind(console))
 *   .catch(console.error.bind(console))
 */
export default class KintoClient {
  /**
   * Constructor.
   *
   * @param  {String} remote  The remote URL.
   * @param  {Object}  options The options object.
   * @param  {Boolean} options.safe        Adds concurrency headers to every
   * requests (default: `false`).
   * @param  {EventEmitter} options.events The events handler. If none provided
   * an `EventEmitter` instance will be created.
   * @param  {Object}  options.headers     The key-value headers to pass to each
   * request (default: `{}`).
   * @param  {String}  options.bucket      The default bucket to use (default:
   * `"default"`)
   * @param  {String}  options.requestMode The HTTP request mode (from ES6 fetch
   * spec).
   */
  constructor(remote, options={}) {
    if (typeof(remote) !== "string" || !remote.length) {
      throw new Error("Invalid remote URL: " + remote);
    }
    if (remote[remote.length-1] === "/") {
      remote = remote.slice(0, -1);
    }
    this._backoffReleaseTime = null;

    // public properties
    /**
     * The remote server base URL.
     * @type {String}
     */
    this.remote = remote;
    /**
     * The default bucket name to use.
     * @type {String}
     */
    this.defaultBucket = options.bucket || "default";
    /**
     * The default safe setting value.
     * @type {Boolean}
     */
    this.defaultSafe = !!options.safe;
    /**
     * The optional generic headers.
     * @type {Object}
     */
    this.optionHeaders = options.headers || {};
    /**
     * Current server settings, retrieved from the server.
     * @type {Object}
     */
    this.serverSettings = null;
    /**
     * The event emitter instance. Should comply with the `EventEmitter`
     * interface.
     * @type {EventEmitter}
     */
    this.events = options.events || new EventEmitter();

    /**
     * The HTTP instance.
     * @type {HTTP}
     */
    this.http = new HTTP(this.events, {requestMode: options.requestMode});
    this._registerHTTPEvents();
  }

  /**
   * The remote endpoint base URL. Setting the value will also extract and
   * validate the version.
   * @type {String}
   */
  get remote() {
    return this._remote;
  }

  /**
   * @ignore
   */
  set remote(url) {
    let version;
    try {
      version = url.match(/\/(v\d+)\/?$/)[1];
    } catch (err) {
      throw new Error("The remote URL must contain the version: " + url);
    }
    if (version !== SUPPORTED_PROTOCOL_VERSION) {
      throw new Error(`Unsupported protocol version: ${version}`);
    }
    this._remote = url;
    this._version = version;
  }

  /**
   * The current server protocol version, eg. `v1`.
   * @type {String}
   */
  get version() {
    return this._version;
  }

  /**
   * Backoff remaining time, in milliseconds. Defaults to zero if no backoff is
   * ongoing.
   *
   * @type {Number}
   */
  get backoff() {
    const currentTime = new Date().getTime();
    if (this._backoffReleaseTime && currentTime < this._backoffReleaseTime) {
      return this._backoffReleaseTime - currentTime;
    }
    return 0;
  }

  /**
   * Registers HTTP events.
   * @private
   */
  _registerHTTPEvents() {
    this.events.on("backoff", backoffMs => {
      this._backoffReleaseTime = backoffMs;
    });
  }

  /**
   * Retrieve a bucket oject to perform operations on it.
   *
   * @param  {String} name The bucket name.
   * @return {Bucket}
   */
  bucket(name) {
    return new Bucket(this, name);
  }

  /**
   * Generates a request options object, deeply merging the client configured
   * defaults with the ones provided as argument.
   *
   * Note: Headers won't be overriden but merged with instance default ones.
   *
   * @private
   * @param  {Object} options The request options.
   * @return {Object}
   * @property {Boolean} safe    The resulting safe option.
   * @property {String}  bucket  The resulting bucket name option.
   * @property {Object}  headers The extended headers object option.
   */
  _getRequestOptions(options={}) {
    return {
      safe: this.defaultSafe,
      bucket: this.defaultBucket,
      ...options,
      // Note: headers should never be overriden but extended
      headers: {...this.optionHeaders, ...options.headers},
    };
  }

  /**
   * Retrieves Kinto server settings.
   *
   * @return {Promise<Object, Error>}
   */
  fetchServerSettings() {
    if (this.serverSettings) {
      return Promise.resolve(this.serverSettings);
    }
    return this.execute({path: endpoint("root")})
      .then(res => {
        this.serverSettings = res.json.settings;
        return this.serverSettings;
      });
  }

  /**
   * Fetches latest changes from the remote server.
   *
   * @param  {String} bucketName  The bucket name.
   * @param  {String} collName    The collection name.
   * @param  {Object} options     The options object.
   * @param  {Boolean} options.safe    The safe option.
   * @param  {String}  options.bucket  The bucket name option.
   * @param  {Object}  options.headers The headers object option.
   * @return {Promise}
   */
  fetchChangesSince(bucketName, collName, options={lastModified: null, headers: {}}) {
    const recordsUrl = endpoint("records", bucketName, collName);
    let queryString = "";
    const headers = {...this.optionHeaders, ...options.headers};

    if (options.lastModified) {
      queryString = "?_since=" + options.lastModified;
      headers["If-None-Match"] = quote(options.lastModified);
    }

    return this.fetchServerSettings()
      .then(_ => this.execute({path: recordsUrl + queryString, headers}))
      .then(res => {
        // If HTTP 304, nothing has changed
        if (res.status === 304) {
          return {
            lastModified: options.lastModified,
            changes: []
          };
        }
        // XXX: ETag are supposed to be opaque and stored «as-is».
        // Extract response data
        let etag = res.headers.get("ETag");  // e.g. '"42"'
        etag = etag ? parseInt(unquote(etag), 10) : options.lastModified;
        const records = res.json.data;

        // Check if server was flushed
        const localSynced = options.lastModified;
        const serverChanged = etag > options.lastModified;
        const emptyCollection = records ? records.length === 0 : true;
        if (localSynced && serverChanged && emptyCollection) {
          throw Error("Server has been flushed.");
        }

        return {lastModified: etag, changes: records};
      });
  }

  /**
   * Process batch requests, chunking them according to the batch_max_requests
   * server setting when needed.
   *
   * @param  {Array}  requests The list of batch subrequests to perform.
   * @param  {Object} options  The options object.
   * @return {Promise<Object, Error>}
   */
  _batchRequests(requests, options = {}) {
    const headers = {...this.optionHeaders, ...options.headers};
    if (!requests.length) {
      return Promise.resolve([]);
    }
    return this.fetchServerSettings()
      .then(serverSettings => {
        const maxRequests = serverSettings["batch_max_requests"];
        if (maxRequests && requests.length > maxRequests) {
          const chunks = partition(requests, maxRequests);
          return pMap(chunks, chunk => this._batchRequests(chunk, options));
        }
        return this.execute({
          path: endpoint("batch"),
          method: "POST",
          headers: headers,
          body: {
            defaults: {headers},
            requests: requests
          }
        })
          // we only care about the responses
          .then(res => res.json.responses);
      });
  }

  /**
   * Sends batch requests to the remote server.
   *
   * @param  {Function} fn      The function to use for describing batch ops.
   * @param  {Object}   options The options object.
   * @param  {Boolean}  options.safe      The safe option.
   * @param  {String}   options.bucket    The bucket name option.
   * @param  {Object}   options.headers   The headers object option.
   * @param  {Boolean}  options.aggregate Produces an aggregated result object
   * (default: `false`).
   * @return {Promise<Object, Error>}
   * @example
   * const client = new KintoClient("https://kinto.dev.mozaws.net/v1");
   * client.batch(batch => {
   *   batch.createBucket("blog");
   *   batch.createCollection("posts");
   *   batch.createRecord("posts", {title: "My first post"});
   * })
   *   .then(console.log.bind(console))
   *   .catch(console.error.bind(console));
   */
  batch(fn, options={}) {
    const batch = createBatch(this._getRequestOptions(options));
    fn(batch);
    return this._batchRequests(batch.requests, options)
      .then((responses) => {
        if (options.aggregate) {
          return aggregate(responses, batch.requests);
        }
        return responses;
      });
  }

  /**
   * Executes an atomic request.
   *
   * @private
   * @param  {Object} request The request object.
   * @return {Promise<Object, Error>}
   */
  execute(request) {
    return this.http.request(this.remote + request.path, {
      ...request,
      body: JSON.stringify(request.body)
    });
  }

  /**
   * Creates a new bucket on the server.
   *
   * @param  {String}   bucketName      The bucket name.
   * @param  {Object}   options         The options object.
   * @param  {Boolean}  options.safe    The safe option.
   * @param  {Object}   options.headers The headers object option.
   * @return {Promise<Object, Error>}
   */
  createBucket(bucketName, options={}) {
    const reqOptions = this._getRequestOptions(options);
    return this.execute(requests.createBucket(bucketName, reqOptions))
      .then(res => res.json);
  }

  /**
   * Retrieves the list of collections attached to a given bucket.
   *
   * @param  {String} bucketName      The bucket name.
   * @param  {Object} options         The options object.
   * @param  {Object} options.headers The headers object option.
   * @return {Promise<String[], Error>}
   */
  getCollections(bucketName, options={}) {
    return this.execute({
      path: endpoint("collections", bucketName),
      headers: {...this.optionHeaders, ...options.headers}
    })
      .then(res => res.json && res.json.data);
  }

  /**
   * Creates a new collection on the server.
   *
   * @param  {Object}  options             The options object.
   * @param  {Boolean} options.safe        The safe option.
   * @param  {String}  options.bucket      The bucket name option.
   * @param  {Object}  options.headers     The headers object option.
   * @param  {String}  options.id          The collection name to create; if not
   * provided, a random collection identifier will be generated by the server.
   * @param  {Object}  options.permissions The permissions object.
   * @param  {Object}  options.schema      The JSONSchema object.
   * @return {Promise<Object, Error>}
   */
  createCollection(options={}) {
    const reqOptions = this._getRequestOptions(options);
    return this.execute(requests.createCollection(reqOptions))
      .then(res => res.json);
  }

  /**
   * Retrieves information for a given collection.
   *
   * @param  {String}   id              The collection name.
   * @param  {Object}   options         The options object.
   * @param  {String}   options.bucket  The bucket name option.
   * @param  {Object}   options.headers The headers object option.
   * @return {Promise<Object, Error>}
   */
  getCollection(id, options={}) {
    const { bucket, headers } = {
      bucket: this.defaultBucket,
      headers: {},
      ...options
    };
    return this.execute({
      path: endpoint("collection", bucket, id),
      headers: {...this.optionHeaders, ...headers}
    }).then(res => res.json);
  }

  /**
   * Updates a collection.
   *
   * @param  {String} id      The collection id.
   * @param  {Object} metas   The metadata to update the collection with; this
   * can be anything but schema and permission, which are handled using
   * dedicated options.
   * @param  {Object}  options             The options object.
   * @param  {Boolean} options.safe        The safe option.
   * @param  {String}  options.bucket      The bucket name option.
   * @param  {Object}  options.headers     The headers object option.
   * @param  {Object}  options.permissions The permissions object.
   * @param  {Object}  options.schema      The JSONSchema object.
   * @return {Promise<Object, Error>}
   */
  updateCollection(id, metas, options={}) {
    const reqOptions = this._getRequestOptions(options);
    return this.execute(requests.updateCollection(id, metas, reqOptions))
      .then(res => res.json);
  }

  /**
   * Get a list of records for a given collection from the server.
   *
   * Note: Because of a bug on the server, the order of records is not
   * predictible, so it's forced in the default options here.
   * See https://github.com/Kinto/kinto/issues/434
   *
   * @param  {String}   collName        The collection name.
   * @param  {Object}   options         The options object.
   * @param  {String}   options.bucket  The bucket name option.
   * @param  {Object}   options.headers The headers object option.
   * @param  {String}   options.sort    The sort field (prefixed with `-` for
   * descending)
   * @return {Promise<Object, Error>}
   */
  getRecords(collName, options={}) {
    const { bucket, sort, headers } = {
      bucket: this.defaultBucket,
      sort: "-last_modified",
      headers: {},
      ...options
    };
    const path = endpoint("records", bucket, collName);
    const querystring = `?_sort=${sort}`;
    return this.execute({
      path: path + querystring,
      headers: {...this.optionHeaders, ...headers},
    }).then(res => res.json);
  }

  /**
   * Creates a record in a given collection.
   *
   * @param  {String}   collName        The collection name.
   * @param  {Object}   record          The record object.
   * @param  {Object}   options         The options object.
   * @param  {Boolean}  options.safe    The safe option.
   * @param  {String}   options.bucket  The bucket name option.
   * @param  {Object}   options.headers The headers object option.
   * @return {Promise<Object, Error>}
   */
  createRecord(collName, record, options={}) {
    const reqOptions = this._getRequestOptions(options);
    return this.execute(requests.createRecord(collName, record, reqOptions))
      .then(res => res.json);
  }

  /**
   * Updates a record in a given collection.
   *
   * @param  {String}   collName        The collection name.
   * @param  {Object}   record          The updated record object.
   * @param  {Object}   options         The options object.
   * @param  {Boolean}  options.safe    The safe option.
   * @param  {String}   options.bucket  The bucket name option.
   * @param  {Object}   options.headers The headers object option.
   * @return {Promise<Object, Error>}
   */
  updateRecord(collName, record, options={}) {
    const reqOptions = this._getRequestOptions(options);
    return this.execute(requests.updateRecord(collName, record, reqOptions))
      .then(res => res.json);
  }

  /**
   * Deletes a record in a given collection.
   *
   * @param  {String}   collName             The collection name.
   * @param  {String}   id                   The record id to delete.
   * @param  {Object}   options              The options object.
   * @param  {Boolean}  options.safe         The safe option.
   * @param  {String}   options.bucket       The bucket name option.
   * @param  {Object}   options.headers      The headers object option.
   * @param  {Object}   options.lastModified The last_modified value to use when
   * the `safe` option is used.
   * @return {Promise<Object, Error>}
   */
  deleteRecord(collName, id, options={}) {
    const reqOptions = this._getRequestOptions(options);
    return this.execute(requests.deleteRecord(collName, id, reqOptions))
      .then(res => res.json);
  }
}
