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
 * @fileOverview Definition of Filter class and its subclasses.
 */

const {Cache} = require("./caching");
const {filterToRegExp} = require("./common");
const {RESOURCE_TYPES, contentTypes} = require("./contentTypes");
const {domainSuffixes, parseDomains} = require("./url");

const resources = require("../data/resources.json");

/**
 * Map of internal resources for URL rewriting.
 * @type {Map.<string,string>}
 */
let resourceMap = new Map(
  Object.keys(resources).map(key => [key, resources[key]])
);

/**
 * Regular expression used to match the `||` prefix in an otherwise literal
 * pattern.
 * @type {RegExp}
 */
let extendedAnchorRegExp = new RegExp(filterToRegExp("||") + "$");

/**
 * Regular expression used to match the `^` suffix in an otherwise literal
 * pattern.
 * @type {RegExp}
 */
// Note: This should match the pattern in lib/common.js
let separatorRegExp = /[\x00-\x24\x26-\x2C\x2F\x3A-\x40\x5B-\x5E\x60\x7B-\x7F]/;

/**
 * Checks whether the given pattern is a string of literal characters with no
 * wildcards or any other special characters.
 *
 * If the pattern is prefixed with a `||` or suffixed with a `^` but otherwise
 * contains no special characters, it is still considered to be a literal
 * pattern.
 *
 * @param {string} pattern
 *
 * @returns {boolean}
 */
function isLiteralPattern(pattern)
{
  return !/[*^|]/.test(pattern.replace(/^\|{1,2}/, "").replace(/[|^]$/, ""));
}

/**
 * Checks whether the given filter is an active filter.
 *
 * Filters of type `blocking`, `whitelist`, `elemhide`, `elemhideexception`,
 * `elemhideemulation`, and `snippet` are considered active; filters of type
 * `invalid` and `comment` are not considered active.
 *
 * @param {?Filter} filter The filter.
 *
 * @returns {boolean} Whether the filter is active.
 */
exports.isActiveFilter = function isActiveFilter(filter)
{
  return filter instanceof ActiveFilter;
};

let Filter =
/**
 * Abstract base class for filters
 */
exports.Filter = class Filter
{
  /**
   * @param {string} text   string representation of the filter
   * @private
   */
  constructor(text)
  {
    this._text = text;
  }

  /**
   * String representation of the filter
   * @type {string}
   */
  get text()
  {
    return this._text;
  }

  /**
   * Filter type as a string, e.g. "blocking".
   * @type {string}
   */
  get type()
  {
    throw new Error("Please define filter type in the subclass");
  }

  toString()
  {
    return this.text;
  }
};

/**
 * Cache of filter objects.
 *
 * @type {Cache.<string, module:filterClasses.Filter>}
 */
let filterCache = new Cache(10000);

/**
 * Regular expression that content filters should match
 * @type {RegExp}
 */
let contentRegExp = /^([^/|@"!]*?)#([@?$])?#(.+)$/;

/**
 * Regular expression that options on a RegExp filter should match
 * @type {RegExp}
 */
let optionsRegExp = /\$(~?[\w-]+(?:=[^,]*)?(?:,~?[\w-]+(?:=[^,]*)?)*)$/;

/**
 * Regular expression that matches an invalid Content Security Policy
 * @type {RegExp}
 */
let invalidCSPRegExp = /(;|^) ?(base-uri|referrer|report-to|report-uri|upgrade-insecure-requests)\b/i;

/**
 * Creates a filter of correct type from its text representation - does the
 * basic parsing and calls the right constructor then.
 *
 * @param {string} text   as in Filter()
 * @param {boolean} [useCache] Whether to use the internal cache of filter
 *   objects.
 * @return {module:filterClasses.Filter}
 */
Filter.fromText = function(text, useCache = true)
{
  let filter = useCache ? filterCache.get(text) : null;
  if (filter)
    return filter;

  if (text[0] == "!")
  {
    filter = new CommentFilter(text);
  }
  else
  {
    let match = text.includes("#") ? contentRegExp.exec(text) : null;
    if (match)
      filter = ContentFilter.fromText(text, match[1], match[2], match[3]);
    else
      filter = URLFilter.fromText(text);
  }

  if (useCache)
    filterCache.set(filter.text, filter);

  return filter;
};

/**
 * Normalizes the text of a filter.
 * @param {?string} text The text of the filter.
 * @returns {?string} The normalized text of the filter. If `text` is `null`,
 *   the return value is `null`.
 * @package
 */
exports.normalizeFilter = function normalizeFilter(text)
{
  if (!text)
    return text;

  // Remove line breaks, tabs etc
  text = text.replace(/[^\S ]+/g, "");

  if (!text.includes(" "))
    return text;

  // Don't remove spaces inside comments
  if (/^ *!/.test(text))
    return text.trim();

  // Special treatment for content filters, right side is allowed to contain
  // spaces
  if (contentRegExp.test(text))
  {
    let [, domains, separator, body] = /^(.*?)(#[@?$]?#?)(.*)$/.exec(text);
    return domains.replace(/ +/g, "") + separator + body.trim();
  }

  // For most regexp filters we strip all spaces, but $csp filter options
  // are allowed to contain single (non trailing) spaces.
  let strippedText = text.replace(/ +/g, "");
  if (!strippedText.includes("$") || !/\bcsp=/i.test(strippedText))
    return strippedText;

  let optionsMatch = optionsRegExp.exec(strippedText);
  if (!optionsMatch)
    return strippedText;

  // For $csp filters we must first separate out the options part of the
  // text, being careful to preserve its spaces.
  let beforeOptions = strippedText.substring(0, optionsMatch.index);
  let strippedDollarIndex = -1;
  let dollarIndex = -1;
  do
  {
    strippedDollarIndex = beforeOptions.indexOf("$", strippedDollarIndex + 1);
    dollarIndex = text.indexOf("$", dollarIndex + 1);
  }
  while (strippedDollarIndex != -1);
  let optionsText = text.substring(dollarIndex + 1);

  // Then we can normalize spaces in the options part safely
  let options = optionsText.split(",");
  for (let i = 0; i < options.length; i++)
  {
    let option = options[i];
    let cspMatch = /^ *c *s *p *=/i.exec(option);
    if (cspMatch)
    {
      options[i] = cspMatch[0].replace(/ +/g, "") +
                   option.substring(cspMatch[0].length).trim().replace(/ +/g, " ");
    }
    else
    {
      options[i] = option.replace(/ +/g, "");
    }
  }

  return beforeOptions + "$" + options.join();
};

/**
 * Class for invalid filters
 */
class InvalidFilter extends Filter
{
  /**
   * @param {string} text see {@link module:filterClasses.Filter Filter()}
   * @param {string} reason Reason why this filter is invalid
   * @private
   */
  constructor(text, reason)
  {
    super(text);

    this._reason = reason;
  }

  get type()
  {
    return "invalid";
  }

  /**
   * Reason why this filter is invalid
   * @type {string}
   */
  get reason()
  {
    return this._reason;
  }
}

/**
 * Class for comments
 */
class CommentFilter extends Filter
{
  /**
   * @param {string} text see {@link module:filterClasses.Filter Filter()}
   * @private
   */
  constructor(text)
  {
    super(text);
  }

  get type()
  {
    return "comment";
  }
}

/**
 * Abstract base class for filters that can get hits
 */
class ActiveFilter extends Filter
{
  /**
   * @param {string} text
   *   see {@link module:filterClasses.Filter Filter()}
   * @param {string} [domains]
   *   Domains that the filter is restricted to separated by domainSeparator
   *   e.g. "foo.com|bar.com|~baz.com"
   * @private
   */
  constructor(text, domains)
  {
    super(text);

    this._domainSource = domains ? domains.toLowerCase() : null;
    this._domains = void 0;
  }

  /**
   * Separator character used in domainSource property
   * @type {string}
   * @protected
   */
  get domainSeparator()
  {
    return ",";
  }

  /**
   * String that the domains property should be generated from
   * @type {?string}
   * @protected
   */
  get domainSource()
  {
    return this._domainSource;
  }

  /**
   * String that the sitekey property should be generated from
   * @type {?string}
   * @protected
   */
  get sitekeySource()
  {
    return null;
  }

  /**
   * Map containing domains that this filter should match on/not match
   * on or null if the filter should match on all domains
   * @type {?Map.<string,boolean>}
   */
  get domains()
  {
    if (typeof this._domains == "undefined")
    {
      let {domainSource} = this;
      this._domains = domainSource ?
                        parseDomains(domainSource, this.domainSeparator) :
                        null;
    }

    return this._domains;
  }

  /**
   * Array containing public keys of websites that this filter should apply to
   * @type {?Array.<string>}
   */
  get sitekeys()
  {
    return null;
  }

  /**
   * Checks whether this filter is active on a domain.
   * @param {?string} [docDomain] domain name of the document that loads the URL
   * @param {string} [sitekey] public key provided by the document
   * @return {boolean} true in case of the filter being active
   */
  isActiveOnDomain(docDomain, sitekey)
  {
    // Sitekeys are case-sensitive so we shouldn't convert them to
    // upper-case to avoid false positives here. Instead we need to
    // change the way filter options are parsed.
    if (this.sitekeys &&
        (!sitekey || !this.sitekeys.includes(sitekey.toUpperCase())))
      return false;

    let {domains} = this;

    // If no domains are set the rule matches everywhere
    if (!domains)
      return true;

    if (docDomain == null)
      docDomain = "";
    else if (docDomain[docDomain.length - 1] == ".")
      docDomain = docDomain.substring(0, docDomain.length - 1);

    // If the document has no host name, match only if the filter
    // isn't restricted to specific domains
    if (!docDomain)
      return domains.get("");

    for (docDomain of domainSuffixes(docDomain))
    {
      let isDomainIncluded = domains.get(docDomain);
      if (typeof isDomainIncluded != "undefined")
        return isDomainIncluded;
    }

    return domains.get("");
  }

  /**
   * Checks whether this filter is active only on a domain and its subdomains.
   * @param {?string} [docDomain]
   * @return {boolean}
   */
  isActiveOnlyOnDomain(docDomain)
  {
    let {domains} = this;

    if (!domains || domains.get(""))
      return false;

    if (docDomain == null)
      docDomain = "";
    else if (docDomain[docDomain.length - 1] == ".")
      docDomain = docDomain.substring(0, docDomain.length - 1);

    if (!docDomain)
      return false;

    for (let [domain, isIncluded] of domains)
    {
      if (isIncluded && domain != docDomain)
      {
        if (domain.length <= docDomain.length)
          return false;

        if (!domain.endsWith("." + docDomain))
          return false;
      }
    }

    return true;
  }

  /**
   * Checks whether this filter is generic or specific
   * @return {boolean}
   */
  isGeneric()
  {
    let {sitekeys, domains} = this;

    return !(sitekeys && sitekeys.length) && (!domains || domains.get(""));
  }
}

/**
 * Abstract base class for URL filters
 */
class URLFilter extends ActiveFilter
{
  /**
   * @param {string} text see {@link module:filterClasses.Filter Filter()}
   * @param {string} regexpSource
   *   filter part that the regular expression should be build from
   * @param {number} [contentType]
   *   Content types the filter applies to, combination of values from
   *   `{@link module:contentTypes.contentTypes}`
   * @param {boolean} [matchCase]
   *   Defines whether the filter should distinguish between lower and upper
   *   case letters
   * @param {string} [domains]
   *   Domains that the filter is restricted to, e.g. "foo.com|bar.com|~baz.com"
   * @param {boolean} [thirdParty]
   *   Defines whether the filter should apply to third-party or first-party
   *   content only
   * @param {string} [sitekeys]
   *   Public keys of websites that this filter should apply to
   * @param {?string} [rewrite]
   *   The name of the internal resource to which to rewrite the
   *   URL. e.g. if the value of the `$rewrite` option is
   *   `abp-resource:blank-html`, this should be `blank-html`.
   *
   * @private
   */
  constructor(text, regexpSource, contentType, matchCase, domains, thirdParty,
              sitekeys, rewrite)
  {
    super(text, domains);

    this._contentType = contentType == null ? RESOURCE_TYPES : contentType;
    this._matchCase = matchCase == null ? false : matchCase;
    this._thirdParty = thirdParty == null ? null : thirdParty;

    this._sitekeySource = sitekeys == null ? null : sitekeys;
    this._sitekeys = void 0;

    this._rewrite = rewrite == null ? null : rewrite;

    this._pattern = null;
    this._regexp = void 0;

    if (!this.matchCase)
      regexpSource = regexpSource.toLowerCase();

    if (regexpSource.length >= 2 &&
        regexpSource[0] == "/" &&
        regexpSource[regexpSource.length - 1] == "/")
    {
      // The filter is a regular expression - convert it immediately to
      // catch syntax errors
      regexpSource = regexpSource.substring(1, regexpSource.length - 1);
      this._regexp = new RegExp(regexpSource);
    }
    else
    {
      // Patterns like /foo/bar/* exist so that they are not treated as regular
      // expressions. We drop any superfluous wildcards here so our
      // optimizations can kick in.
      regexpSource = regexpSource.replace(/^\*+/, "").replace(/\*+$/, "");

      // No need to convert this filter to regular expression yet, do it on
      // demand
      this._pattern = regexpSource;
    }
  }

  /**
   * @see ActiveFilter.domainSeparator
   */
  get domainSeparator()
  {
    return "|";
  }

  /**
   * Expression from which a regular expression should be generated -
   * for delayed creation of the regexp property
   * @type {?string}
   */
  get pattern()
  {
    return this._pattern;
  }

  /**
   * Regular expression to be used when testing against this filter
   * @type {RegExp}
   */
  get regexp()
  {
    if (typeof this._regexp == "undefined")
    {
      let {pattern} = this;
      this._regexp = isLiteralPattern(pattern) ? null :
                       new RegExp(filterToRegExp(pattern));
    }

    return this._regexp;
  }

  /**
   * Content types the filter applies to, combination of values from
   * `{@link module:contentTypes.contentTypes}`
   * @type {number}
   */
  get contentType()
  {
    return this._contentType;
  }

  /**
   * Defines whether the filter should distinguish between lower and
   * upper case letters
   * @type {boolean}
   */
  get matchCase()
  {
    return this._matchCase;
  }

  /**
   * Defines whether the filter should apply to third-party or
   * first-party content only. Can be null (apply to all content).
   * @type {?boolean}
   */
  get thirdParty()
  {
    return this._thirdParty;
  }

  /**
   * @see ActiveFilter.sitekeySource
   */
  get sitekeySource()
  {
    return this._sitekeySource;
  }

  /**
   * @see ActiveFilter.sitekeys
   */
  get sitekeys()
  {
    if (typeof this._sitekeys == "undefined")
    {
      let {sitekeySource} = this;
      this._sitekeys = sitekeySource ? sitekeySource.split("|") : null;
    }

    return this._sitekeys;
  }

  /**
   * The name of the internal resource to which to rewrite the
   * URL. e.g. if the value of the `$rewrite` option is
   * `abp-resource:blank-html`, this should be `blank-html`.
   * @type {?string}
   */
  get rewrite()
  {
    return this._rewrite;
  }

  /**
   * Tests whether the URL request matches this filter
   * @param {module:url.URLRequest} request URL request to be tested
   * @param {number} typeMask bitmask of content / request types to match
   * @param {?string} [sitekey] public key provided by the document
   * @return {boolean} true in case of a match
   */
  matches(request, typeMask, sitekey)
  {
    return (this.contentType & typeMask) != 0 &&
           (this.thirdParty == null || this.thirdParty == request.thirdParty) &&
           this._matchesLocation(request) &&
           this.isActiveOnDomain(request.documentHostname, sitekey);
  }

  /**
   * Checks whether the given URL request matches this filter's pattern.
   * @param {module:url.URLRequest} request The URL request to check.
   * @returns {boolean} `true` if the URL request matches.
   * @private
   */
  _matchesLocation(request)
  {
    let location = this.matchCase ? request.href : request.lowerCaseHref;

    let {regexp} = this;

    if (regexp)
      return regexp.test(location);

    let {pattern} = this;

    let startsWithAnchor = pattern[0] == "|";
    let startsWithExtendedAnchor = startsWithAnchor && pattern[1] == "|";
    let endsWithSeparator = pattern[pattern.length - 1] == "^";
    let endsWithAnchor = !endsWithSeparator &&
                         pattern[pattern.length - 1] == "|";

    if (startsWithExtendedAnchor)
      pattern = pattern.substr(2);
    else if (startsWithAnchor)
      pattern = pattern.substr(1);

    if (endsWithSeparator || endsWithAnchor)
      pattern = pattern.slice(0, -1);

    let index = location.indexOf(pattern);

    // The "||" prefix requires that the text that follows does not start
    // with a forward slash.
    return index != -1 &&
           (startsWithExtendedAnchor ?
              location[index] != "/" &&
              extendedAnchorRegExp.test(location.substring(0, index)) :
              startsWithAnchor ?
                index == 0 :
                true) &&
           (endsWithSeparator ?
              !location[index + pattern.length] ||
              separatorRegExp.test(location[index + pattern.length]) :
              endsWithAnchor ?
                index == location.length - pattern.length :
                true);
  }
}

/**
 * Creates a URL filter from its text representation
 * @param {string} text   same as in Filter()
 * @return {module:filterClasses.Filter}
 */
URLFilter.fromText = function(text)
{
  let blocking = true;
  let origText = text;
  if (text[0] == "@" && text[1] == "@")
  {
    blocking = false;
    text = text.substring(2);
  }

  let contentType = null;
  let matchCase = null;
  let domains = null;
  let sitekeys = null;
  let thirdParty = null;
  let csp = null;
  let rewrite = null;
  let options;
  let match = text.includes("$") ? optionsRegExp.exec(text) : null;
  if (match)
  {
    options = match[1].split(",");
    text = match.input.substring(0, match.index);
    for (let option of options)
    {
      let value = null;
      let separatorIndex = option.indexOf("=");
      if (separatorIndex >= 0)
      {
        value = option.substring(separatorIndex + 1);
        option = option.substring(0, separatorIndex);
      }

      let inverse = option[0] == "~";
      if (inverse)
        option = option.substring(1);

      let type = contentTypes[option.replace(/-/, "_").toUpperCase()];
      if (type)
      {
        if (inverse)
        {
          if (contentType == null)
            contentType = RESOURCE_TYPES;
          contentType &= ~type;
        }
        else
        {
          contentType |= type;

          if (type == contentTypes.CSP)
          {
            if (blocking && !value)
              return new InvalidFilter(origText, "filter_invalid_csp");
            csp = value;
          }
        }
      }
      else
      {
        switch (option.toLowerCase())
        {
          case "match-case":
            matchCase = !inverse;
            break;
          case "domain":
            if (!value)
              return new InvalidFilter(origText, "filter_unknown_option");
            domains = value;
            break;
          case "third-party":
            thirdParty = !inverse;
            break;
          case "sitekey":
            if (!value)
              return new InvalidFilter(origText, "filter_unknown_option");
            sitekeys = value.toUpperCase();
            break;
          case "rewrite":
            if (value == null)
              return new InvalidFilter(origText, "filter_unknown_option");
            if (!value.startsWith("abp-resource:"))
              return new InvalidFilter(origText, "filter_invalid_rewrite");
            rewrite = value.substring("abp-resource:".length);
            break;
          default:
            return new InvalidFilter(origText, "filter_unknown_option");
        }
      }
    }
  }

  try
  {
    if (blocking)
    {
      if (csp && invalidCSPRegExp.test(csp))
        return new InvalidFilter(origText, "filter_invalid_csp");

      if (rewrite)
      {
        if (text[0] == "|" && text[1] == "|")
        {
          if (!domains && thirdParty != false)
            return new InvalidFilter(origText, "filter_invalid_rewrite");
        }
        else if (text[0] == "*")
        {
          if (!domains)
            return new InvalidFilter(origText, "filter_invalid_rewrite");
        }
        else
        {
          return new InvalidFilter(origText, "filter_invalid_rewrite");
        }
      }

      return new BlockingFilter(origText, text, contentType, matchCase, domains,
                                thirdParty, sitekeys, rewrite, csp);
    }

    return new WhitelistFilter(origText, text, contentType, matchCase, domains,
                               thirdParty, sitekeys);
  }
  catch (e)
  {
    return new InvalidFilter(origText, "filter_invalid_regexp");
  }
};

/**
 * Class for blocking filters
 */
class BlockingFilter extends URLFilter
{
  /**
   * @param {string} text see {@link module:filterClasses.Filter Filter()}
   * @param {string} regexpSource see
   *   {@link module:filterClasses.URLFilter URLFilter()}
   * @param {number} [contentType] see
   *   {@link module:filterClasses.URLFilter URLFilter()}
   * @param {boolean} [matchCase] see
   *   {@link module:filterClasses.URLFilter URLFilter()}
   * @param {string} [domains] see
   *   {@link module:filterClasses.URLFilter URLFilter()}
   * @param {boolean} [thirdParty] see
   *   {@link module:filterClasses.URLFilter URLFilter()}
   * @param {string} [sitekeys] see
   *   {@link module:filterClasses.URLFilter URLFilter()}
   * @param {?string} [rewrite]
   *   The name of the internal resource to which to rewrite the
   *   URL. e.g. if the value of the `$rewrite` option is
   *   `abp-resource:blank-html`, this should be `blank-html`.
   * @param {string} [csp]
   *   Content Security Policy to inject when the filter matches
   *
   * @private
   */
  constructor(text, regexpSource, contentType, matchCase, domains, thirdParty,
              sitekeys, rewrite, csp)
  {
    super(text, regexpSource, contentType, matchCase, domains, thirdParty,
          sitekeys, rewrite);

    this._csp = csp == null ? null : csp;
  }

  get type()
  {
    return "blocking";
  }

  /**
   * Content Security Policy to inject for matching requests.
   * @type {?string}
   */
  get csp()
  {
    return this._csp;
  }

  /**
   * Rewrites an URL.
   * @param {string} url the URL to rewrite
   * @return {string} the rewritten URL, or the original in case of failure
   */
  rewriteUrl(url)
  {
    return resourceMap.get(this.rewrite) || url;
  }
}

/**
 * Class for whitelist filters
 */
class WhitelistFilter extends URLFilter
{
  /**
   * @param {string} text see {@link module:filterClasses.Filter Filter()}
   * @param {string} regexpSource see
   *   {@link module:filterClasses.URLFilter URLFilter()}
   * @param {number} [contentType] see
   *   {@link module:filterClasses.URLFilter URLFilter()}
   * @param {boolean} [matchCase] see
   *   {@link module:filterClasses.URLFilter URLFilter()}
   * @param {string} [domains] see
   *   {@link module:filterClasses.URLFilter URLFilter()}
   * @param {boolean} [thirdParty] see
   *   {@link module:filterClasses.URLFilter URLFilter()}
   * @param {string} [sitekeys] see
   *   {@link module:filterClasses.URLFilter URLFilter()}
   *
   * @private
   */
  constructor(text, regexpSource, contentType, matchCase, domains, thirdParty,
              sitekeys)
  {
    super(text, regexpSource, contentType, matchCase, domains, thirdParty,
          sitekeys);
  }

  get type()
  {
    return "whitelist";
  }
}

/**
 * Base class for content filters
 */
class ContentFilter extends ActiveFilter
{
  /**
   * @param {string} text see {@link module:filterClasses.Filter Filter()}
   * @param {string} [domains] Host names or domains the filter should be
   *                           restricted to
   * @param {string} body      The body of the filter
   *
   * @private
   */
  constructor(text, domains, body)
  {
    super(text, domains || null);

    this._body = body;
  }

  /**
   * The body of the filter
   * @type {string}
   */
  get body()
  {
    return this._body;
  }
}

/**
 * Creates a content filter from a pre-parsed text representation
 *
 * @param {string} text         same as in Filter()
 * @param {string} [domains]
 *   domains part of the text representation
 * @param {string} [type]
 *   rule type, either:
 *     * "" for an element hiding filter
 *     * "@" for an element hiding exception filter
 *     * "?" for an element hiding emulation filter
 *     * "$" for a snippet filter
 * @param {string} body
 *   body part of the text representation, either a CSS selector or a snippet
 *   script
 * @return {module:filterClasses.ElemHideFilter|
 *          module:filterClasses.ElemHideException|
 *          module:filterClasses.ElemHideEmulationFilter|
 *          module:filterClasses.SnippetFilter|
 *          module:filterClasses.InvalidFilter}
 */
ContentFilter.fromText = function(text, domains, type, body)
{
  // We don't allow content filters which have any empty domains.
  // Note: The ContentFilter#domainSeparator is duplicated here, if that
  // changes this must be changed too.
  if (domains && /(^|,)~?(,|$)/.test(domains))
    return new InvalidFilter(text, "filter_invalid_domain");

  if (type == "@")
    return new ElemHideException(text, domains, body);

  if (type == "?" || type == "$")
  {
    // Element hiding emulation and snippet filters are inefficient so we need
    // to make sure that they're only applied if they specify active domains
    if (!(/,[^~][^,.]*\.[^,]/.test("," + domains) ||
          ("," + domains + ",").includes(",localhost,")))
    {
      return new InvalidFilter(text, type == "?" ?
                                       "filter_elemhideemulation_nodomain" :
                                       "filter_snippet_nodomain");
    }

    if (type == "?")
      return new ElemHideEmulationFilter(text, domains, body);

    return new SnippetFilter(text, domains, body);
  }

  return new ElemHideFilter(text, domains, body);
};

/**
 * Base class for element hiding filters
 */
class ElemHideBase extends ContentFilter
{
  /**
   * @param {string} text see {@link module:filterClasses.Filter Filter()}
   * @param {string} [domains] see
   *   {@link module:filterClasses.ContentFilter ContentFilter()}
   * @param {string} selector  CSS selector for the HTML elements that should be
   *                           hidden
   *
   * @private
   */
  constructor(text, domains, selector)
  {
    super(text, domains, selector);
  }

  /**
   * CSS selector for the HTML elements that should be hidden
   * @type {string}
   */
  get selector()
  {
    return this.body;
  }
}

/**
 * Class for element hiding filters
 */
class ElemHideFilter extends ElemHideBase
{
  /**
   * @param {string} text see {@link module:filterClasses.Filter Filter()}
   * @param {string} [domains]  see
   *   {@link module:filterClasses.ElemHideBase ElemHideBase()}
   * @param {string} selector see
   *   {@link module:filterClasses.ElemHideBase ElemHideBase()}
   *
   * @private
   */
  constructor(text, domains, selector)
  {
    super(text, domains, selector);
  }

  get type()
  {
    return "elemhide";
  }
}

/**
 * Class for element hiding exceptions
 */
class ElemHideException extends ElemHideBase
{
  /**
   * @param {string} text see {@link module:filterClasses.Filter Filter()}
   * @param {string} [domains]  see
   *   {@link module:filterClasses.ElemHideBase ElemHideBase()}
   * @param {string} selector see
   *   {@link module:filterClasses.ElemHideBase ElemHideBase()}
   *
   * @private
   */
  constructor(text, domains, selector)
  {
    super(text, domains, selector);
  }

  get type()
  {
    return "elemhideexception";
  }
}

/**
 * Class for element hiding emulation filters
 */
class ElemHideEmulationFilter extends ElemHideBase
{
  /**
   * @param {string} text    see {@link module:filterClasses.Filter Filter()}
   * @param {string} domains see
   *   {@link module:filterClasses.ElemHideBase ElemHideBase()}
   * @param {string} selector see
   *   {@link module:filterClasses.ElemHideBase ElemHideBase()}
   * @constructor
   * @augments module:filterClasses.ElemHideBase
   *
   * @private
   */
  constructor(text, domains, selector)
  {
    super(text, domains, selector);
  }

  get type()
  {
    return "elemhideemulation";
  }
}

/**
 * Class for snippet filters
 */
class SnippetFilter extends ContentFilter
{
  /**
   * @param {string} text see Filter()
   * @param {string} [domains] see ContentFilter()
   * @param {string} script    Script that should be executed
   * @constructor
   * @augments module:filterClasses.ContentFilter
   *
   * @private
   */
  constructor(text, domains, script)
  {
    super(text, domains, script);
  }

  get type()
  {
    return "snippet";
  }

  /**
   * Script that should be executed
   * @type {string}
   */
  get script()
  {
    return this.body;
  }
}
