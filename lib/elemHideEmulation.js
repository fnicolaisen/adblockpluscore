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
 * @fileOverview Element hiding emulation implementation.
 */

const {Filter} = require("./filterClasses");
const {FiltersByDomain} = require("./filtersByDomain");
const {elemHideExceptions} = require("./elemHideExceptions");
const {domainSuffixes} = require("./url");

/**
 * `{@link module:elemHideEmulation.elemHideEmulation elemHideEmulation}`
 * implementation.
 */
class ElemHideEmulation
{
  /**
   * @hideconstructor
   */
  constructor()
  {
    /**
     * All known element hiding emulation filters.
     * @type {Set.<string>}
     * @private
     */
    this._filters = new Set();

    /**
     * Lookup table, active flag, by filter by domain.
     * @type {FiltersByDomain}
     * @private
     */
    this._filtersByDomain = new FiltersByDomain();
  }

  /**
   * Removes all known element hiding emulation filters.
   */
  clear()
  {
    this._filters.clear();
    this._filtersByDomain.clear();
  }

  /**
   * Adds a new element hiding emulation filter.
   * @param {module:filterClasses.ElemHideEmulationFilter} filter
   */
  add(filter)
  {
    if (this._filters.has(filter.text))
      return;

    this._filtersByDomain.add(filter.text, filter.domains);

    this._filters.add(filter.text);
  }

  /**
   * Removes an existing element hiding emulation filter.
   * @param {module:filterClasses.ElemHideEmulationFilter} filter
   */
  remove(filter)
  {
    if (!this._filters.has(filter.text))
      return;

    this._filtersByDomain.remove(filter.text, filter.domains);

    this._filters.delete(filter.text);
  }

  /**
   * Checks whether an element hiding emulation filter exists.
   * @param {module:filterClasses.ElemHideEmulationFilter} filter
   * @returns {boolean}
   */
  has(filter)
  {
    return this._filters.has(filter.text);
  }

  /**
   * Returns a list of all element hiding emulation filters active on the given
   * domain.
   * @param {string} domain The domain.
   * @returns {Array.<module:filterClasses.ElemHideEmulationFilter>} A list of
   *   element hiding emulation filters.
   */
  getFilters(domain)
  {
    let filters = [];

    let excluded = new Set();

    for (let currentDomain of domainSuffixes(domain))
    {
      let map = this._filtersByDomain.get(currentDomain);
      if (map)
      {
        for (let [text, include] of (typeof map != "string" ?
                                       map.entries() : [[map, true]]))
        {
          if (!include)
          {
            excluded.add(text);
          }
          else if (excluded.size == 0 || !excluded.has(text))
          {
            let filter = Filter.fromText(text);
            if (!elemHideExceptions.getException(filter.selector, domain))
              filters.push(filter);
          }
        }
      }
    }

    return filters;
  }

  /**
   * Returns a list of all element hiding emulation filters active on the given
   * domain.
   * @param {string} domain The domain.
   * @returns {Array.<module:filterClasses.ElemHideEmulationFilter>} A list of
   *   element hiding emulation filters.
   *
   * @deprecated Use
   *   <code>{@link
   *          module:elemHideEmulation~ElemHideEmulation#getFilters}</code>
   *   instead.
   * @see module:elemHideEmulation~ElemHideEmulation#getFilters
   */
  getRulesForDomain(domain)
  {
    return this.getFilters(domain);
  }
}

/**
 * Container for element hiding emulation filters.
 * @type {module:elemHideEmulation~ElemHideEmulation}
 */
exports.elemHideEmulation = new ElemHideEmulation();
