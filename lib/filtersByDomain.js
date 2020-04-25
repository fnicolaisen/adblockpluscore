/*
 * This file is part of Adblock Plus <https://adblockplus.org/>,
 * Copyright (C) 2006-present eyeo GmbH
 *
 * Adblock Plus is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License version 3 as
 * published by the Free Software Foundation.
 *
 * Adblock Plus is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with Adblock Plus.  If not, see <http://www.gnu.org/licenses/>.
 */

/** @module */

"use strict";

/**
 * Map to be used instead when a filter has a blank `domains` property.
 * @type {Map.<string, boolean>}
 */
let defaultDomains = new Map([["", true]]);

let FilterMap =
/**
 * A `FilterMap` object contains a set of filters, each mapped to a boolean
 * value indicating whether the filter should be applied.
 *
 * It is used by
 * `{@link module:filtersByDomain.FiltersByDomain FiltersByDomain}`.
 *
 * @package
 */
exports.FilterMap = class FilterMap
{
  /**
   * Creates a `FilterMap` object.
   * @param {?Array.<Array>} [entries] The initial entries in the object.
   * @see #entries
   * @private
   */
  constructor(entries)
  {
    this._map = new Map(entries);
  }

  /**
   * Returns the number of filters in the object.
   * @returns {number}
   */
  get size()
  {
    return this._map.size;
  }

  /**
   * Yields all the filters in the object along with a boolean value for each
   * filter indicating whether the filter should be applied.
   *
   * @returns {object} An iterator that yields a two-tuple containing a
   *   string and a `boolean` value.
   */
  entries()
  {
    return this._map.entries();
  }

  /**
   * Yields all the filters in the object.
   *
   * @returns {object} An iterator that yields a string.
   */
  keys()
  {
    return this._map.keys();
  }

  /**
   * Returns a boolean value indicating whether the filter referenced by the
   * given key should be applied.
   *
   * @param {string} key The text of the filter.
   *
   * @returns {boolean|undefined} Whether the filter should be applied. If the
   *   object does not contain the filter referenced by `key`, returns
   *   `undefined`.
   */
  get(key)
  {
    return this._map.get(key);
  }

  /**
   * Sets the boolean value for the filter referenced by the given key
   * indicating whether the filter should be applied.
   *
   * @param {string} key The text of the filter.
   * @param {boolean} value The boolean value.
   */
  set(key, value)
  {
    this._map.set(key, value);
  }

  /**
   * Removes the filter referenced by the given key.
   *
   * @param {string} key The text of the filter.
   */
  delete(key)
  {
    this._map.delete(key);
  }
};

/**
 * A `FiltersByDomain` object contains a set of domains, each mapped to a set
 * of filters along with a boolean value for each filter indicating whether the
 * filter should be applied to the domain.
 *
 * @package
 */
exports.FiltersByDomain = class FiltersByDomain
{
  /**
   * Creates a `FiltersByDomain` object.
   */
  constructor()
  {
    this._map = new Map();
  }

  /**
   * Returns the number of domains in the object.
   * @returns {number}
   */
  get size()
  {
    return this._map.size;
  }

  /**
   * Yields all the domains in the object along with a set of filters for each
   * domain, each filter in turn mapped to a boolean value indicating whether
   * the filter should be applied to the domain.
   *
   * @returns {object} An iterator that yields a two-tuple containing a
   *   `string` and either a
   *   `{@link module:filtersByDomain.FilterMap FilterMap}` object
   *   or a single string. In the latter case, it directly indicates that the
   *   filter should be applied.
   */
  entries()
  {
    return this._map.entries();
  }

  /**
   * Returns a boolean value asserting whether the object contains the domain
   * referenced by the given key.
   *
   * @param {string} key The domain.
   *
   * @returns {boolean} Whether the object contains the domain referenced by
   *   `key`.
   */
  has(key)
  {
    return this._map.has(key);
  }

  /**
   * Returns a set of filters for the domain referenced by the given key, along
   * with a boolean value for each filter indicating whether the filter should
   * be applied to the domain.
   *
   * @param {string} key The domain.
   *
   * @returns {module:filtersByDomain.FilterMap|string|undefined} Either a
   *   `{@link module:filtersByDomain.FilterMap FilterMap}` object or a single
   *   string. In the latter case, it directly indicates that the filter should
   *   be applied. If this `FiltersByDomain` object does not contain the domain
   *   referenced by `key`, the return value is `undefined`.
   */
  get(key)
  {
    return this._map.get(key);
  }

  /**
   * Removes all the domains in the object.
   */
  clear()
  {
    this._map.clear();
  }

  /**
   * Adds a filter and all of its domains to the object.
   *
   * @param {string} text The text of the filter.
   * @param {Map.<string, boolean>} domains The filter's domains.
   */
  add(text, domains)
  {
    for (let [domain, include] of domains || defaultDomains)
    {
      if (!include && domain == "")
        continue;

      let map = this._map.get(domain);
      if (!map)
      {
        this._map.set(domain, include ? text : new FilterMap([[text, false]]));
      }
      else if (typeof map == "string")
      {
        if (text != map)
          this._map.set(domain, new FilterMap([[map, true], [text, include]]));
      }
      else
      {
        map.set(text, include);
      }
    }
  }

  /**
   * Removes a filter and all of its domains from the object.
   *
   * @param {string} text The text of the filter.
   * @param {Map.<string, boolean>} domains The filter's domains.
   */
  remove(text, domains)
  {
    for (let domain of (domains || defaultDomains).keys())
    {
      let map = this._map.get(domain);
      if (map)
      {
        if (typeof map != "string")
        {
          map.delete(text);

          if (map.size == 0)
          {
            this._map.delete(domain);
          }
          else if (map.size == 1)
          {
            for (let [lastFilter, include] of map.entries())
            {
              // Reduce Map { "example.com" => Map { text => true } } to
              // Map { "example.com" => text }
              if (include)
                this._map.set(domain, lastFilter);

              break;
            }
          }
        }
        else if (text == map)
        {
          this._map.delete(domain);
        }
      }
    }
  }
};
