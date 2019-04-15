const isFunction = x => typeof x === 'function'
const isUndefined = x => typeof x === 'undefined'
const isDefined = x => typeof x !== 'undefined'
const isObject = x => typeof x === 'object'

export default class DataBatcher {
  constructor (batchLoadFn, batchSaveFn, options) {
    this._batchLoadFn = this._prepareBatchLoadFn(batchLoadFn)
    this._batchSaveFn = this._prepareBatchSaveFn(batchSaveFn, options)
    this._options = this._prepareOptions(batchSaveFn, options)

    this._loadCache = {}
    this._flushing = false
    this._queue = []
  }

  _prepareBatchLoadFn (batchLoadFn) {
    if (!isFunction(batchLoadFn)) {
      throw new TypeError(
        'DataBatcher must be constructed with a batch load function which accepts ' +
          `Array<key> and returns Promise<Array<value>>, but got: ${batchLoadFn}.`
      )
    }

    return batchLoadFn
  }

  _prepareBatchSaveFn (batchSaveFn, options) {
    // second param is options
    if (isUndefined(options) && isObject(batchSaveFn)) {
      return null
    }

    if (isDefined(batchSaveFn) && !isFunction(batchSaveFn)) {
      throw new TypeError(
        'DataBatcher must be constructed with a batch save function which accepts ' +
          `Array<[key,value]> and returns Promise<Array<void>>, but got: ${batchSaveFn}.`
      )
    }

    return batchSaveFn
  }

  _prepareOptions (batchSaveFn, options) {
    if (isUndefined(options) && isObject(batchSaveFn)) {
      options = batchSaveFn
    }

    return options || {}
  }

  loadMany (keys) {
    return Promise.all(keys.map(this.load.bind(this)))
  }

  load (key) {
    const shouldCache = this._options.cache !== false
    const cacheKeyFn = this._options.cacheKeyFn
    const cacheKey = cacheKeyFn ? cacheKeyFn(key) : key

    if (shouldCache) {
      return (
        this._loadCache[cacheKey] ||
        (this._loadCache[cacheKey] = this._loadLater(key))
      )
    } else {
      return this._loadLater(key)
    }
  }

  _loadLater (key) {
    return new Promise((resolve, reject) => {
      this._queue.push({ resolve, reject, key, type: 'load' })
      if (this._queue.length === 1 && !this._flushing) {
        process.nextTick(this._flushQueue.bind(this))
      }
    })
  }

  saveMany (saves) {
    return Promise.all(saves.map(([key, value]) => this.save(key, value)))
  }

  save (key, value) {
    // clear item from load cache
    const cacheKeyFn = this._options.cacheKeyFn
    const cacheKey = cacheKeyFn ? cacheKeyFn(key) : key
    delete this._loadCache[cacheKey]

    return this._saveLater(key, value)
  }

  _saveLater (key, value) {
    return new Promise((resolve, reject) => {
      this._queue.push({ resolve, reject, key, value, type: 'save' })
      if (this._queue.length === 1 && !this._flushing) {
        process.nextTick(this._flushQueue.bind(this))
      }
    })
  }

  async _flushQueue () {
    if (this._queue.length === 0) {
      this._flushing = false
      return
    }

    this._flushing = true

    const queueLength = this._queue.length
    const maxBatchSize = this._options.maxBatchSize
      ? Math.min(this._options.maxBatchSize, queueLength)
      : queueLength

    const batchType = this._queue[0].type

    let batchSize = 1
    while (
      batchSize < maxBatchSize &&
      this._queue[batchSize].type === batchType
    ) {
      batchSize++
    }

    const batch = this._queue.splice(0, batchSize)
    if (batchType === 'load') {
      await this._batchLoad(batch)
    } /* if (batchType === 'save') */ else {
      await this._batchSave(batch)
    }

    this._flushQueue()
  }

  async _batchLoad (batch) {
    const loadResult = await this._checkLoadResult(
      this._batchLoadFn(batch.map(({ key }) => key)),
      batch.length
    )
    if (loadResult instanceof Error) {
      batch.forEach(({ reject }) => reject(loadResult))
    } else {
      batch.forEach(({ resolve, reject }, index) => {
        const result = loadResult[index]
        return result instanceof Error ? reject(result) : resolve(result)
      })
    }
  }

  async _checkLoadResult (loadResultPromise, expectedLength) {
    if (!loadResultPromise || !loadResultPromise.then) {
      return new Error(
        `batchLoadFn must return Promise<Array<value>> but got: ${loadResultPromise}`
      )
    }

    let loadResult = await loadResultPromise
    if (!Array.isArray(loadResult)) {
      return new Error(
        `batchLoadFn must return Promise<Array<value>> but got: Promise<${loadResult}>`
      )
    }

    if (loadResult.length !== expectedLength) {
      return new Error(
        `batchLoadFn must return Promise<Array<value>> of length ${expectedLength} but got length: ${
          loadResult.length
        }`
      )
    }

    return loadResult
  }

  async _batchSave (batch) {
    const saveResult = await this._checkSaveResult(
      this._batchSaveFn(batch.map(({ key, value }) => [key, value])),
      batch.length
    )

    if (saveResult instanceof Error) {
      batch.forEach(({ reject }) => reject(saveResult))
    } else {
      batch.forEach(({ resolve, reject }, index) => {
        const result = saveResult[index]
        return result instanceof Error ? reject(result) : resolve(result)
      })
    }
  }

  async _checkSaveResult (saveResultPromise, expectedLength) {
    if (!saveResultPromise || !saveResultPromise.then) {
      return new Error(
        `batchSaveFn must return Promise<Array<any>> but got: ${saveResultPromise}`
      )
    }

    let saveResult = await saveResultPromise
    if (!Array.isArray(saveResult)) {
      return new Error(
        `batchSaveFn must return Promise<Array<any>> but got: Promise<${saveResult}>`
      )
    }

    if (saveResult.length !== expectedLength) {
      return new Error(
        `batchSaveFn must return Promise<Array<any>> of length ${expectedLength} but got length: ${
          saveResult.length
        }`
      )
    }

    return saveResult
  }
}
