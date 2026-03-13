"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.orderUseCases = void 0;
const orderRepository_1 = require("../repositories/orderRepository");
const userRepository_1 = require("../repositories/userRepository");
const sheetsService_1 = require("../services/sheetsService");
exports.orderUseCases = {
    create: async (data) => {
        const order = await orderRepository_1.orderRepository.create(data);
        const buyer = await userRepository_1.userRepository.findById(data.buyerId);
        if (buyer) {
            await Promise.all(order.items.map(async (item) => {
                try {
                    await sheetsService_1.sheetsService.appendOrderRow({
                        orderId: order.id,
                        createdAt: order.createdAt.toISOString(),
                        userEmail: buyer.email,
                        productTitle: item.product.title,
                        sku: item.product.sku,
                        variant: item.variant?.name ?? '-',
                        qty: item.quantity,
                        price: item.priceAtPurchase,
                        currency: item.currency,
                        status: order.status
                    });
                }
                catch (error) {
                    console.warn('Sheets append failed', error);
                }
            }));
        }
        return order;
    },
    listByBuyer: orderRepository_1.orderRepository.findByBuyer,
    get: orderRepository_1.orderRepository.findById,
    listBySeller: (sellerId, options) => orderRepository_1.orderRepository.findSellerOrders(sellerId, options)
};
