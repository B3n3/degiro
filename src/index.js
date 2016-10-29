/// <reference path="../typings/index.d.ts" />

const fetch = require('node-fetch');
const querystring = require('querystring');
const parseCookies = require('cookie').parse;
const {Actions, OrderTypes, TimeTypes, ProductTypes, Sort} = require('./constants');
const omitBy = require('lodash/omitBy');
const isNil = require('lodash/isNil');

const create = ({
    username = process.env.DEGIRO_USER,
    password = process.env.DEGIRO_PASS,
    debug = false,
} = {}) => {    

    const log = debug ? (...s) => console.log(...s) : () => {};

    const session = {
        id: '',
        account: 0,
    };

    const checkSuccess = (res) => {
        if (res.status !== 0) {
            throw Error(res.message);
        }
        return res;
    };

    /**
     * Keep the session alive
     */
    const checkSession = () => {
        return fetch(`https://trader.degiro.nl/trading/secure/v5/update/${session.account};jsessionid=${session.id}`)
        .then(res => res.json())
        .then(json => log('checkSession', json))
        .catch(err => {
            log('Reset session');
            session.id = '';
            session.account = 0;
            login();
        });
    };

    /**
     * Update client info
     * @return {Promise}
     */
    const updateClientInfo = () => {
        log('updateClientInfo');
        return fetch(`https://trader.degiro.nl/pa/secure/client?sessionId=${session.id}`)
        .then(res => res.json())
        .then(({intAccount}) => {session.account = intAccount});
    };

    /**
     * Login
     * 
     * @return {Promise} Resolves to {sessionId: string}
     */
    const login = () => {
        log('login', username, '********');
        return fetch('https://trader.degiro.nl/login/securityCheck', {
            method: 'POST',
            headers: {'Content-Type': 'application/x-www-form-urlencoded'},
            body: querystring.stringify({j_username: username, j_password: password}),
            redirect: 'manual',
        })
        .then(res => {
            const cookies = parseCookies(res.headers.get('set-cookie') || '');
            session.id = cookies.JSESSIONID;
        })
        .then(updateClientInfo)
        .then(() => session);
    };

    const ensureLogin = () => {}

    /**
     * Search product by name and type
     * 
     * @param {string} options.text - Search term. For example: "Netflix" or "NFLX"
     * @param {number} options.productType - See ProductTypes. Defaults to ProductTypes.all
     * @param {number} options.sortColumn - Column to sory by. For example: "name". Defaults to `undefined`
     * @param {number} options.sortType - See SortTypes. Defaults to `undefined`
     * @param {number} options.limit - Results limit. Defaults to 7
     * @param {number} options.offset - Results offset. Defaults to 0 
     * @return {Promise} Resolves to {data: Product[]}
     */
    const searchProduct = ({text: searchText, productType = ProductTypes.all, sortColumn, sortType, limit = 7, offset = 0}) => {
        const options = {searchText, productType, sortColumn, sortType, limit, offset};
        const params = querystring.stringify(omitBy(options, isNil));
        log('searchProduct', params);
        return fetch(`https://trader.degiro.nl/product_search/secure/v4/product/lookup?intAccount=${session.account}&sessionId=${session.id}&${params}`)
        .then(res => res.json());        
    };

    /**
     * Check order
     * 
     * @param {number} order.action - See Actions
     * @param {number} order.orderType - See OrderTypes
     * @param {string} order.productId
     * @param {number} order.size
     * @param {number} order.timeType - See TimeTypes
     * @param {number} order.price - Required for limited and stopLimited orders
     * @param {number} order.stopPrice - Required for stopLoss and stopLimited orders
     * @return {Promise} Resolves to {order: Object, confirmationId: string}
     */
    const checkOrder = (order) => {
        const {buysell, orderType, productId, size, timeType, price, stopPrice} = order;
        log('checkOrder', {buysell, orderType, productId, size, timeType, price, stopPrice});
        return fetch(`https://trader.degiro.nl/trading/secure/v5/checkOrder;jsessionid=${session.id}?intAccount=${session.account}&sessionId=${session.id}`, {
            method: 'POST',
            headers: {'Content-Type': 'application/json;charset=UTF-8'},
            body: JSON.stringify(order),
        })
        .then(res => res.json())
        .then(checkSuccess)
        .then(json => ({order, confirmationId: json.confirmationId}));
    };

    /**
     * Confirm order
     * 
     * @param {Object} options.order - As returned by checkOrder()
     * @param {string} options.confirmationId - As returned by checkOrder()
     * @return {Promise} Resolves to {orderId: string}
     */
    const confirmOrder = ({order, confirmationId}) => {
        log('confirmOrder', {order, confirmationId});
        return fetch(`https://trader.degiro.nl/trading/secure/v5/order/${confirmationId};jsessionid=${session.id}?intAccount=${session.account}&sessionId=${session.id}`, {
            method: 'POST',
            headers: {'Content-Type': 'application/json;charset=UTF-8'},
            body: JSON.stringify(order),
        })
        .then(res => res.json())
        .then(checkSuccess)
        .then(json => ({orderId: json.orderId}));
    };
    
    /**
     * Returns the first product of a product search response
     * 
     * @param {Object} result - Product search result
     * @return {Object} Product record
     */
    const returnFirstProductResult = (result) => {
        if (Array.isArray(result.data) && result.data.length) {
            return result.data[0];
        }
        throw new Error('Product not found');
    };

    /**
     * Buy product
     * 
     * @param {number} options.orderType - See OrderTypes
     * @param {string} options.productSymbol - Product symbol. For example: 'AAPL'
     * @param {number} options.productType - See ProductTypes. Defaults to ProductTypes.shares
     * @param {number} options.size - Number of items to buy
     * @param {number} options.timeType - See TimeTypes
     * @param {number} options.price
     * @param {number} options.stopPrice
     */
    const buy = ({orderType, productSymbol, productType = ProductTypes.shares, size, timeType, price, stopPrice}) => {
        return searchProduct({text: productSymbol, productType, limit: 1})
        .then(returnFirstProductResult)
        .then(({id}) => checkOrder({buysell: Actions.buy, orderType, productId: id, size, timeType, price, stopPrice}))
        .then(confirmOrder);
    };

    /**
     * Sell product
     * 
     * @param {number} options.orderType - See OrderTypes
     * @param {string} options.productSymbol - Product symbol. For example: 'AAPL'
     * @param {number} options.productType - See ProductTypes. Defaults to ProductTypes.shares
     * @param {number} options.size - Number of items to buy
     * @param {number} options.timeType - See TimeTypes. Defaults to TimeTypes.day
     * @param {number} options.price
     * @param {number} options.stopPrice
     */
    const sell = ({orderType, productSymbol, productType = ProductTypes.shares, size, timeType = TimeTypes.day, price, stopPrice}) => {
        return searchProduct({text: productSymbol, productType, limit: 1})
        .then(returnFirstProductResult)
        .then(({id}) => checkOrder({buysell: Actions.sell, orderType, productId: id, size, timeType, price, stopPrice}))
        .then(confirmOrder);
    };

    return {
        // methods
        login,
        searchProduct,
        buy,
        sell,
        // properties
        session,
    };
};

module.exports = {
    create,
    Actions,
    OrderTypes,
    ProductTypes,
    TimeTypes,
    Sort,
};