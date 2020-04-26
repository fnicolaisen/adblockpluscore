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
 * @fileOverview Matcher class implementing matching addresses against
 *               a list of filters.
 */

const {Cache} = require("./caching");
const {filterToRegExp} = require("./common");
const {SPECIAL_TYPES, WHITELISTING_TYPES} = require("./contentTypes");
const {Filter} = require("./filterClasses");
const {FiltersByDomain} = require("./filtersByDomain");
const {URLRequest, domainSuffixes} = require("./url");

/**
 * @typedef {string|module:filterClasses.URLFilter|
 *           Array.<string|module:filterClasses.URLFilter>}
 *   FiltersForKeyword
 */

/**
 * Regular expression for matching a keyword in a filter.
 * @type {RegExp}
 */
let keywordRegExp = /[^a-z0-9%*][a-z0-9%]{2,}(?=[^a-z0-9%*])/;

/**
 * Regular expression for matching all keywords in a filter.
 * @type {RegExp}
 */
let allKeywordsRegExp = new RegExp(keywordRegExp, "g");

/**
 * The maximum number of patterns that
 * `{@link module:matcher~compilePatterns compilePatterns()}` will compile
 * into regular expressions.
 * @type {number}
 */
const COMPILE_PATTERNS_MAX = 100;

/**
 * Checks if the keyword is bad for use.
 * @param {string} keyword
 * @returns {boolean}
 */
function isBadKeyword(keyword)
{
  return keyword == "https" || keyword == "http" || keyword == "com" ||
         keyword == "js";
}

/**
 * A `CompiledPatterns` object represents the compiled version of multiple URL
 * request patterns. It is returned by
 * `{@link module:matcher~compilePatterns compilePatterns()}`.
 */
class CompiledPatterns
{
  /**
   * Creates an object with the given regular expressions for case-sensitive
   * and case-insensitive matching respectively.
   * @param {?RegExp} [caseSensitive]
   * @param {?RegExp} [caseInsensitive]
   * @private
   */
  constructor(caseSensitive, caseInsensitive)
  {
    this._caseSensitive = caseSensitive;
    this._caseInsensitive = caseInsensitive;
  }

  /**
   * Tests whether the given URL request matches the patterns used to create
   * this object.
   * @param {module:url.URLRequest} request
   * @returns {boolean}
   */
  test(request)
  {
    return ((this._caseSensitive &&
             this._caseSensitive.test(request.href)) ||
            (this._caseInsensitive &&
             this._caseInsensitive.test(request.lowerCaseHref)));
  }
}

/**
 * Compiles patterns from the given filters into a single
 * `{@link module:matcher~CompiledPatterns CompiledPatterns}` object.
 *
 * @param {URLFilter|Array.<URLFilter>} filters
 *   The filters. If the number of filters exceeds
 *   `{@link module:matcher~COMPILE_PATTERNS_MAX COMPILE_PATTERNS_MAX}`, the
 *   function returns `null`.
 *
 * @returns {?module:matcher~CompiledPatterns}
 */
function compilePatterns(filters)
{
  // If the number of filters is too large, it may choke especially on low-end
  // platforms. As a precaution, we refuse to compile. Ideally we would check
  // the length of the regular expression source rather than the number of
  // filters, but this is far more straightforward and practical.
  if (filters.length > COMPILE_PATTERNS_MAX)
    return null;

  let caseSensitive = "";
  let caseInsensitive = "";

  for (let filter of Array.isArray(filters) ? filters : [filters])
  {
    let source = filter.pattern != null ? filterToRegExp(filter.pattern) :
                   filter.regexp.source;

    if (filter.matchCase)
      caseSensitive += source + "|";
    else
      caseInsensitive += source + "|";
  }

  let caseSensitiveRegExp = null;
  let caseInsensitiveRegExp = null;

  try
  {
    if (caseSensitive)
      caseSensitiveRegExp = new RegExp(caseSensitive.slice(0, -1));

    if (caseInsensitive)
      caseInsensitiveRegExp = new RegExp(caseInsensitive.slice(0, -1));
  }
  catch (error)
  {
    // It is possible in theory for the regular expression to be too large
    // despite COMPILE_PATTERNS_MAX
    return null;
  }

  return new CompiledPatterns(caseSensitiveRegExp, caseInsensitiveRegExp);
}

/**
 * Adds a filter by a given keyword to a map.
 * @param {string|module:filterClasses.URLFilter} filter
 * @param {string} keyword
 * @param {Map.<string, module:matcher~FiltersForKeyword>} map
 */
function addFilterByKeyword(filter, keyword, map)
{
  let list = map.get(keyword);
  if (typeof list == "undefined")
    map.set(keyword, filter);
  else if (typeof list == "string" || list instanceof Filter)
    map.set(keyword, [list, filter]);
  else
    list.push(filter);
}

/**
 * Removes a filter by a given keyword from a map.
 * @param {string|module:filterClasses.URLFilter} filter
 * @param {string} keyword
 * @param {Map.<string, module:matcher~FiltersForKeyword>} map
 */
// eslint-disable-next-line no-unused-vars
function removeFilterByKeyword(filter, keyword, map)
{
  let text = typeof filter == "string" ? filter : filter.text;

  let list = map.get(keyword);
  if (typeof list == "undefined")
    return;

  if (typeof list == "string" || list instanceof Filter)
  {
    if (text == list)
      map.delete(keyword);
  }
  else
  {
    let index = 0;
    for (let item of list)
    {
      if (text == (typeof item == "string" ? item : item.text))
        break;

      index++;
    }

    if (index < list.length)
      list.splice(index, 1);

    if (list.length == 1)
      map.set(keyword, list[0]);
  }
}

/**
 * Checks whether a filter matches a given URL request.
 *
 * @param {module:filterClasses.URLFilter} filter The filter.
 * @param {module:url.URLRequest} request The URL request.
 * @param {number} typeMask A mask specifying the content type of the URL
 *   request.
 * @param {?string} [sitekey] An optional public key associated with the
 *   URL request.
 * @param {?Array} [collection] An optional list to which to append the filter
 *   if it matches. If omitted, the function directly returns the filter if it
 *   matches.
 *
 * @returns {?module:filterClasses.URLFilter} The filter if it matches and
 *   `collection` is omitted; otherwise `null`.
 */
function matchFilter(filter, request, typeMask, sitekey, collection)
{
  if (filter.matches(request, typeMask, sitekey))
  {
    if (!collection)
      return filter;

    collection.push(filter);
  }

  return null;
}

/**
 * Checks whether a particular filter is slow.
 * @param {module:filterClasses.URLFilter} filter
 * @returns {boolean}
 */
exports.isSlowFilter = function isSlowFilter(filter)
{
  return !filter.pattern || !keywordRegExp.test(filter.pattern);
};

let Matcher =
/**
 * Blocking/whitelist filter matching
 */
exports.Matcher = class Matcher
{
  constructor()
  {
    /**
     * Lookup table for keywords by their associated filter
     * @type {Map.<string, string>}
     * @private
     */
    this._keywordByFilter = new Map();

    /**
     * Number of filters by keyword
     * @type {Map.<string, number>}
     * @private
     */
    this._filterCountByKeyword = new Map();

    /**
     * Lookup table for filters by their associated keyword
     * @type {Map.<string, module:matcher~FiltersForKeyword>}
     * @private
     */
    this._filtersByKeyword = new Map();

    /**
     * Lookup table of type-specific lookup tables for filters by their
     * associated keyword
     * @type {Map.<string, Map.<string, module:matcher~FiltersForKeyword>>}
     * @private
     */
    this._filterMapsByType = new Map();

    /**
     * Lookup table of domain maps for filters by their associated keyword
     * @type {Map.<string, module:filtersByDomain:FiltersByDomain>}
     * @private
     */
    this._filterDomainMapsByKeyword = new Map();

    /**
     * Lookup table of compiled patterns for filters by their associated
     * keyword
     * @type {Map.<string, ?module:matcher~CompiledPatterns>}
     * @private
     */
    this._compiledPatternsByKeyword = new Map();
  }

  /**
   * Removes all known filters
   */
  clear()
  {
    this._keywordByFilter.clear();
    this._filterCountByKeyword.clear();
    this._filtersByKeyword.clear();
    this._filterMapsByType.clear();
    this._filterDomainMapsByKeyword.clear();
    this._compiledPatternsByKeyword.clear();
  }

  /**
   * Adds a filter to the matcher
   * @param {module:filterClasses.URLFilter} filter
   */
  add(filter)
  {
    let {text} = filter;
    if (this._keywordByFilter.has(text))
      return;

    // Look for a suitable keyword
    let keyword = this.findKeyword(filter);

    this._keywordByFilter.set(text, keyword);

    let count = this._filterCountByKeyword.get(keyword) || 0;
    this._filterCountByKeyword.set(keyword, count + 1);

    if (this._filtersByKeyword.size > 0)
    {
      this._filtersByKeyword.clear();
      this._filterMapsByType.clear();
      this._filterDomainMapsByKeyword.clear();
      this._compiledPatternsByKeyword.clear();
    }
  }

  /**
   * Removes a filter from the matcher
   * @param {module:filterClasses.URLFilter} filter
   */
  remove(filter)
  {
    let {text} = filter;
    let keyword = this._keywordByFilter.get(text);
    if (typeof keyword == "undefined")
      return;

    this._keywordByFilter.delete(text);

    let count = this._filterCountByKeyword.get(keyword);
    if (count > 1)
      this._filterCountByKeyword.set(keyword, count - 1);
    else
      this._filterCountByKeyword.delete(keyword);

    if (this._filtersByKeyword.size > 0)
    {
      this._filtersByKeyword.clear();
      this._filterMapsByType.clear();
      this._filterDomainMapsByKeyword.clear();
      this._compiledPatternsByKeyword.clear();
    }
  }

  /**
   * Checks whether a filter exists in the matcher
   * @param {module:filterClasses.URLFilter} filter
   * @returns {boolean}
   */
  has(filter)
  {
    return this._keywordByFilter.has(filter.text);
  }

  /**
   * Chooses a keyword to be associated with the filter
   * @param {module:filterClasses.Filter} filter
   * @returns {string} keyword or an empty string if no keyword could be found
   * @protected
   */
  findKeyword(filter)
  {
    let result = "";

    let {pattern} = filter;
    if (pattern == null)
      return result;

    let candidates = pattern.toLowerCase().match(allKeywordsRegExp);
    if (!candidates)
      return result;

    let resultCount = 0xFFFFFF;
    let resultLength = 0;

    for (let i = 0, l = candidates.length; i < l; i++)
    {
      let candidate = candidates[i].substring(1);

      if (isBadKeyword(candidate))
        continue;

      let count = this._filterCountByKeyword.get(candidate) || 0;
      if (count < resultCount ||
          (count == resultCount && candidate.length > resultLength))
      {
        result = candidate;
        resultCount = count;
        resultLength = candidate.length;
      }
    }

    return result;
  }

  _getFiltersForKeyword(keyword)
  {
    if (this._filtersByKeyword.size == 0 && this._keywordByFilter.size > 0)
    {
      for (let [filter_, keyword_] of this._keywordByFilter)
        addFilterByKeyword(filter_, keyword_, this._filtersByKeyword);
    }

    let filters = this._filtersByKeyword.get(keyword);
    if (!filters)
      return null;

    // Convert filter text to filter objects.
    if (typeof filters == "string")
    {
      let filter = Filter.fromText(filters);
      this._filtersByKeyword.set(keyword, filter);
      return filter;
    }

    if (Array.isArray(filters) && typeof filters[0] == "string")
    {
      for (let i = 0; i < filters.length; i++)
        filters[i] = Filter.fromText(filters[i]);
    }

    return filters;
  }

  _checkEntryMatchForType(keyword, request, typeMask, sitekey, specificOnly,
                          collection)
  {
    let filtersForKeyword = this._getFiltersForKeyword(keyword);
    if (!filtersForKeyword)
      return null;

    let filtersForType = this._filterMapsByType.get(typeMask);

    if (!filtersForType)
      this._filterMapsByType.set(typeMask, filtersForType = new Map());

    let filters = filtersForType.get(keyword);
    if (typeof filters == "undefined")
    {
      filters = [];

      for (let filter of Array.isArray(filtersForKeyword) ?
                           filtersForKeyword :
                           [filtersForKeyword])
      {
        if ((filter.contentType & typeMask) != 0)
        {
          addFilterByKeyword(filter, keyword, filtersForType);
          filters.push(filter);
        }
      }

      // Add a default null entry to avoid the same processing each time.
      if (filters.length == 0)
        filtersForType.set(keyword, filters = null);
    }

    if (filters)
    {
      for (let filter of Array.isArray(filters) ? filters : [filters])
      {
        if (specificOnly && filter.isGeneric())
          continue;

        if (matchFilter(filter, request, typeMask, sitekey, collection))
          return filter;
      }
    }

    return null;
  }

  _checkEntryMatchByDomain(keyword, request, typeMask, sitekey, specificOnly,
                           collection)
  {
    let filtersForKeyword = this._getFiltersForKeyword(keyword);
    if (!filtersForKeyword)
      return null;

    if (Array.isArray(filtersForKeyword) &&
        filtersForKeyword.length <= COMPILE_PATTERNS_MAX)
    {
      let compiled = this._compiledPatternsByKeyword.get(keyword);
      if (typeof compiled == "undefined")
      {
        compiled = compilePatterns(filtersForKeyword);
        this._compiledPatternsByKeyword.set(keyword, compiled);
      }

      if (compiled && !compiled.test(request))
        return null;
    }

    let filtersByDomain = this._filterDomainMapsByKeyword.get(keyword);
    if (!filtersByDomain)
    {
      filtersByDomain = new FiltersByDomain();
      this._filterDomainMapsByKeyword.set(keyword, filtersByDomain);

      for (let filter of Array.isArray(filtersForKeyword) ?
                           filtersForKeyword :
                           [filtersForKeyword])
        filtersByDomain.add(filter, filter.domains);
    }

    let excluded = null;

    for (let suffix of domainSuffixes(request.documentHostname || "",
                                      !specificOnly))
    {
      let map = filtersByDomain.get(suffix);
      if (!map)
        continue;

      for (let [filter, include] of map instanceof Filter ?
                                      [[map, true]] :
                                      map.entries())
      {
        if (!include)
        {
          if (excluded)
            excluded.add(filter);
          else
            excluded = new Set([filter]);
        }
        else if (!excluded || !excluded.has(filter))
        {
          if (matchFilter(filter, request, typeMask, sitekey, collection))
            return filter;
        }
      }
    }

    return null;
  }

  /**
   * Checks whether the entries for a particular keyword match a URL
   * @param {string} keyword
   * @param {module:url.URLRequest} request
   * @param {number} typeMask
   * @param {?string} [sitekey]
   * @param {boolean} [specificOnly]
   * @param {?Array.<module:filterClasses.Filter>} [collection] An optional
   *   list of filters to which to append any results. If specified, the
   *   function adds *all* matching filters to the list; if omitted,
   *   the function directly returns the first matching filter.
   * @returns {?module:filterClasses.Filter}
   * @protected
   */
  checkEntryMatch(keyword, request, typeMask, sitekey, specificOnly,
                  collection)
  {
    // If the type mask contains a special type (first condition) and it is
    // the only type in the mask (second condition), we can use the
    // type-specific map, which typically contains a lot fewer filters. This
    // enables faster lookups for whitelisting types like $document, $elemhide,
    // and so on, as well as other special types like $csp.
    if ((typeMask & SPECIAL_TYPES) != 0 && (typeMask & typeMask - 1) == 0)
    {
      return this._checkEntryMatchForType(keyword, request, typeMask, sitekey,
                                          specificOnly, collection);
    }

    return this._checkEntryMatchByDomain(keyword, request, typeMask, sitekey,
                                         specificOnly, collection);
  }

  /**
   * @see #match
   * @deprecated
   * @inheritdoc
   */
  matchesAny(url, typeMask, docDomain, sitekey, specificOnly)
  {
    return this.match(url, typeMask, docDomain, sitekey, specificOnly);
  }

  /**
   * Tests whether the URL matches any of the known filters
   * @param {URL|module:url~URLInfo} url
   *   URL to be tested
   * @param {number} typeMask
   *   bitmask of content / request types to match
   * @param {?string} [docDomain]
   *   domain name of the document that loads the URL
   * @param {?string} [sitekey]
   *   public key provided by the document
   * @param {boolean} [specificOnly]
   *   should be `true` if generic matches should be ignored
   * @returns {?module:filterClasses.URLFilter}
   *   matching filter or `null`
   */
  match(url, typeMask, docDomain, sitekey, specificOnly)
  {
    let request = URLRequest.from(url, docDomain);
    let candidates = request.lowerCaseHref.match(/[a-z0-9%]{2,}|$/g);

    for (let i = 0, l = candidates.length; i < l; i++)
    {
      if (isBadKeyword(candidates[i]))
        continue;

      let result = this.checkEntryMatch(candidates[i], request, typeMask,
                                        sitekey, specificOnly);
      if (result)
        return result;
    }

    return null;
  }
};

let CombinedMatcher =
/**
 * Combines a matcher for blocking and exception rules, automatically sorts
 * rules into two `{@link module:matcher.Matcher Matcher}` instances.
 */
exports.CombinedMatcher = class CombinedMatcher
{
  constructor()
  {
    /**
     * Matcher for blocking rules.
     * @type {module:matcher.Matcher}
     * @private
     */
    this._blocking = new Matcher();

    /**
     * Matcher for exception rules.
     * @type {module:matcher.Matcher}
     * @private
     */
    this._whitelist = new Matcher();

    /**
     * Lookup table of previous match results
     * @type {module:caching.Cache.<string, ?(module:filterClasses.URLFilter|
     *                                        MatcherSearchResults)>}
     * @private
     */
    this._resultCache = new Cache(10000);
  }

  /**
   * @see module:matcher.Matcher#clear
   */
  clear()
  {
    this._blocking.clear();
    this._whitelist.clear();
    this._resultCache.clear();
  }

  /**
   * @see module:matcher.Matcher#add
   * @param {module:filterClasses.Filter} filter
   */
  add(filter)
  {
    if (filter.type == "whitelist")
      this._whitelist.add(filter);
    else
      this._blocking.add(filter);

    this._resultCache.clear();
  }

  /**
   * @see module:matcher.Matcher#remove
   * @param {module:filterClasses.Filter} filter
   */
  remove(filter)
  {
    if (filter.type == "whitelist")
      this._whitelist.remove(filter);
    else
      this._blocking.remove(filter);

    this._resultCache.clear();
  }

  /**
   * @see module:matcher.Matcher#has
   * @param {module:filterClasses.Filter} filter
   * @returns {boolean}
   */
  has(filter)
  {
    if (filter.type == "whitelist")
      return this._whitelist.has(filter);
    return this._blocking.has(filter);
  }

  /**
   * @see module:matcher.Matcher#findKeyword
   * @param {module:filterClasses.Filter} filter
   * @returns {string} keyword
   * @protected
   */
  findKeyword(filter)
  {
    if (filter.type == "whitelist")
      return this._whitelist.findKeyword(filter);
    return this._blocking.findKeyword(filter);
  }

  /**
   * @see #match
   * @deprecated
   * @inheritdoc
   */
  matchesAny(url, typeMask, docDomain, sitekey, specificOnly)
  {
    return this.match(url, typeMask, docDomain, sitekey, specificOnly);
  }

  /**
   * @see module:matcher.Matcher#match
   * @inheritdoc
   */
  match(url, typeMask, docDomain, sitekey, specificOnly)
  {
    let key = url.href + " " + typeMask + " " + docDomain + " " + sitekey +
              " " + specificOnly;

    let result = this._resultCache.get(key);
    if (typeof result != "undefined")
      return result;

    result = this._matchInternal(url, typeMask, docDomain, sitekey,
                                 specificOnly);

    this._resultCache.set(key, result);

    return result;
  }

  /**
   * @typedef {object} MatcherSearchResults
   * @property {Array.<module:filterClasses.BlockingFilter>} [blocking] List of
   *   blocking filters found.
   * @property {Array.<module:filterClasses.WhitelistFilter>} [whitelist] List
   *   of whitelist filters found.
   */

  /**
   * Searches all blocking and whitelist filters and returns results matching
   * the given parameters.
   *
   * @param {URL|module:url~URLInfo} url
   * @param {number} typeMask
   * @param {?string} [docDomain]
   * @param {?string} [sitekey]
   * @param {boolean} [specificOnly]
   * @param {string} [filterType] The types of filters to look for. This can be
   *   `"blocking"`, `"whitelist"`, or `"all"` (default).
   *
   * @returns {MatcherSearchResults}
   */
  search(url, typeMask, docDomain, sitekey, specificOnly, filterType = "all")
  {
    let key = "* " + url.href + " " + typeMask + " " + docDomain + " " +
              sitekey + " " + specificOnly + " " + filterType;

    let result = this._resultCache.get(key);
    if (typeof result != "undefined")
      return result;

    result = this._searchInternal(url, typeMask, docDomain, sitekey,
                                  specificOnly, filterType);

    this._resultCache.set(key, result);

    return result;
  }

  /**
   * Tests whether the URL is whitelisted
   * @see module:matcher.Matcher#match
   * @inheritdoc
   * @returns {boolean}
   */
  isWhitelisted(url, typeMask, docDomain, sitekey)
  {
    return !!this._whitelist.match(url, typeMask, docDomain, sitekey);
  }

  _matchInternal(url, typeMask, docDomain, sitekey, specificOnly)
  {
    let request = URLRequest.from(url, docDomain);
    let candidates = request.lowerCaseHref.match(/[a-z0-9%]{2,}|$/g);

    let whitelistHit = null;
    let blockingHit = null;

    // If the type mask includes no types other than whitelisting types, we
    // can skip the blocking filters.
    if ((typeMask & ~WHITELISTING_TYPES) != 0)
    {
      for (let i = 0, l = candidates.length; !blockingHit && i < l; i++)
      {
        if (isBadKeyword(candidates[i]))
          continue;

        blockingHit = this._blocking.checkEntryMatch(candidates[i], request,
                                                     typeMask, sitekey,
                                                     specificOnly);
      }
    }

    // If the type mask includes any whitelisting types, we need to check the
    // whitelist filters.
    if (blockingHit || (typeMask & WHITELISTING_TYPES) != 0)
    {
      for (let i = 0, l = candidates.length; !whitelistHit && i < l; i++)
      {
        if (isBadKeyword(candidates[i]))
          continue;

        whitelistHit = this._whitelist.checkEntryMatch(candidates[i], request,
                                                       typeMask, sitekey);
      }
    }

    return whitelistHit || blockingHit;
  }

  _searchInternal(url, typeMask, docDomain, sitekey, specificOnly, filterType)
  {
    let hits = {};

    let searchBlocking = filterType == "blocking" || filterType == "all";
    let searchWhitelist = filterType == "whitelist" || filterType == "all";

    if (searchBlocking)
      hits.blocking = [];

    if (searchWhitelist)
      hits.whitelist = [];

    // If the type mask includes no types other than whitelisting types, we
    // can skip the blocking filters.
    if ((typeMask & ~WHITELISTING_TYPES) == 0)
      searchBlocking = false;

    let request = URLRequest.from(url, docDomain);
    let candidates = request.lowerCaseHref.match(/[a-z0-9%]{2,}|$/g);

    for (let i = 0, l = candidates.length; i < l; i++)
    {
      if (isBadKeyword(candidates[i]))
        continue;

      if (searchBlocking)
      {
        this._blocking.checkEntryMatch(candidates[i], request, typeMask,
                                       sitekey, specificOnly, hits.blocking);
      }

      if (searchWhitelist)
      {
        this._whitelist.checkEntryMatch(candidates[i], request, typeMask,
                                        sitekey, false, hits.whitelist);
      }
    }

    return hits;
  }
};

/**
 * Shared `{@link module:matcher.CombinedMatcher CombinedMatcher}` instance
 * that should usually be used.
 * @type {module:matcher.CombinedMatcher}
 */
exports.defaultMatcher = new CombinedMatcher();
