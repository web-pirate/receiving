import { ShipmentService } from "@/services/ShipmentService";
import { ActionTree } from 'vuex'
import RootState from '@/store/RootState'
import ShipmentState from './ShipmentState'
import * as types from './mutation-types'
import { hasError, showToast } from '@/utils'
import { translate } from '@/i18n'
import emitter from '@/event-bus'

const actions: ActionTree<ShipmentState, RootState> = {
  async findShipment ({ commit, state, dispatch }, payload) {
    let resp;
    try {
      resp = await ShipmentService.fetchShipments(payload)
      if (resp.status === 200 && resp.data.docs?.length > 0 && !hasError(resp)) {
        let shipments = resp.data.docs;
        if (payload.viewIndex && payload.viewIndex > 0) shipments = state.shipments.list.concat(shipments);
        const statusIds = shipments.map((shipment: any) => shipment.statusId)
        await dispatch('fetchStatus', statusIds);
        shipments.map(async (shipment: any) => {
          shipment.statusDesc = state.status[shipment.statusId]
          const itemCount = await dispatch('fetchItemCount', shipment.shipmentId);
          shipment.noOfItem = itemCount;
        });
        commit(types.SHIPMENT_LIST_UPDATED, { shipments })
      } else {
        showToast(translate("Shipments not found"));
      }
      if (payload.viewIndex === 0) emitter.emit("dismissLoader");
    } catch(error){
      console.error(error)
      showToast(translate("Something went wrong"));
    }
    return resp;
  },
  async fetchStatus({ state, commit }, statusIds) {
    let resp;

    const cachedStatus = JSON.parse(JSON.stringify(state.status));
    const statusIdFilter = statusIds.reduce((filter: Array<string>, statusId: any) => {
      if (!cachedStatus[statusId]) {
        filter.push(statusId)
      }
      return filter;
    }, []);

    if (statusIdFilter.length <= 0) return cachedStatus;

    try {
      resp = await ShipmentService.fetchStatus({
        "entityName": "StatusItem",
        "noConditionFind": "Y",
        "distinct": "Y",
        "viewSize": 100,
        "inputFields": {
          "statusId": statusIdFilter,
          "statusId_op": "in"
        },
        "fieldList": ["statusId", "description"],
      })

      if (resp.status == 200 && !hasError(resp) && resp.data.count) {
        const statuses = resp.data.docs;
        statuses.map((status: any) => {
          cachedStatus[status.statusId] = status.description
        })
        commit(types.SHIPMENT_STATUS_UPDATED, cachedStatus);
      } else {
        console.error(resp);
      }
    } catch(err) {
      console.error('Something went wrong while fetching status for items and orders')
    }
    return cachedStatus;
  },
  async fetchItemCount({commit}, shipmentId){
    let resp;
    try {
      resp = await ShipmentService.fetchItemCount({
        "entityName": "ShipmentItem",
        "noConditionFind": "Y",
        "inputFields": {
          "shipmentId": shipmentId,
        },
      })
      if(resp.status === 200 && !hasError(resp) && resp.data){
        return resp.data.count ? resp.data.count : 0
      } else {
        return 0;
      }
    } catch (err) {
      console.error(err);
      return 0;
    }
  },

  async updateShipmentProductCount ({ commit, state }, payload) {
    await state.current.items.find((item: any) => {
      if(item.sku === payload){
        item.quantityAccepted = parseInt(item.quantityAccepted) + 1;
      }
    });
    commit(types.SHIPMENT_CURRENT_UPDATED, state);
  },
  async setCurrent ({ commit }, payload) {
    let resp;
    try {
      resp = await ShipmentService.getShipmentDetail(payload);
      if (resp.status === 200 && resp.data.items&& !hasError(resp)) {
        commit(types.SHIPMENT_CURRENT_UPDATED, { current: resp.data })
        let productIds: any = new Set();
        resp.data.items.forEach((item: any) => {
          productIds.add(item.productId)
        });

        productIds = [...productIds]
        if(productIds.length) {
          this.dispatch('product/fetchProducts', { productIds })
        }
        return resp.data;
      } else {
        showToast(translate('Something went wrong'));
        console.log("error", resp.data._ERROR_MESSAGE_);
        return Promise.reject(new Error(resp.data._ERROR_MESSAGE_));
      }

    } catch (err) {
      showToast(translate('Something went wrong'));
      console.log("error", err);
      return Promise.reject(new Error(err))
    }
  },
  receiveShipmentItem ({ commit }, data) {
    const payload = data.shipment ? {
      shipmentId: data.shipment.shipmentId,
      locationSeqId: data.shipment.locationSeqId
    } : {
      shipmentId: data.shipmentId,
      locationSeqId: data.locationSeqId
    }
    return Promise.all(data.items.map((item: any) => {
      const params = {
        ...payload,
        facilityId: this.state.user.currentFacility.facilityId,
        shipmentItemSeqId: item.itemSeqId,
        productId: item.productId,
        quantityAccepted: item.quantityAccepted,
        orderId: item.orderId,
        orderItemSeqId: item.orderItemSeqId,
        unitCost: 0.00
      }
      return ShipmentService.receiveShipmentItem(params).catch((err) => {
        return err;
      })
    }))
  },
  async receiveShipment ({ dispatch }, {payload}) {
    emitter.emit("presentLoader");
    return await dispatch("receiveShipmentItem", payload).then(async( ) => {
      const resp = await ShipmentService.receiveShipment({
        "shipmentId": payload.shipment ? payload.shipment.shipmentId : payload.shipmentId,
        "statusId": "PURCH_SHIP_RECEIVED"
      })
      if (resp.status == 200 && !hasError(resp)) {
        showToast(translate("Shipment Received Successfully") + ' ' + (payload.shipment ? payload.shipment.shipmentId : payload.shipmentId))
      }
      emitter.emit("dismissLoader");
      return resp;
    }).catch(err => err);
  },
  async addShipmentItem ({ state, commit, dispatch }, payload) {
    const item = payload.shipmentId ? { ...(payload.item) } : { ...payload }
    const product = {
      ...item,
      quantityAccepted: 0,
      quantityOrdered: 0
    }
    const params = {
      orderId: payload.orderId,
      productId: product.productId,
      quantity: 0,
      shipmentId: payload.shipmentId ? payload.shipmentId : state.current.shipmentId,
      shipmentItemSeqId: payload.shipmentItemSeqId
    }
    const resp = await ShipmentService.addShipmentItem(params);
    if(resp.status == 200 && !hasError(resp)){
      dispatch('updateProductCount', { shipmentId: resp.data.shipmentId })
      if (!payload.shipmentId) commit(types.SHIPMENT_CURRENT_PRODUCT_ADDED, product)
      return resp;
    }
    else {
      showToast(translate('Something went wrong'));
      console.log("error", resp._ERROR_MESSAGE_);
      return Promise.reject(new Error(resp.data._ERROR_MESSAGE_));
    }
  },

  async updateProductCount({ commit, state }, payload ) {
    const shipments = state.shipments.list;
    shipments.forEach((shipment: any) => {
      if(shipment.id === payload.shipmentId) {
        shipment.noOfItem = parseInt(shipment.noOfItem) + 1;
        return;
      }
    })

    commit(types.SHIPMENT_LIST_UPDATED, { shipments })
  },

  async clearShipments({ commit }) {
    commit(types.SHIPMENT_LIST_UPDATED, { shipments: [] })
    commit(types.SHIPMENT_CURRENT_UPDATED, { current: {} })
  }
}

export default actions;