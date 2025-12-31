import { Router } from 'express';
import { z } from 'zod';
import { PrismaClient } from '@prisma/client';
import { requireAuth } from '../../middleware/requireAuth';

const router = Router();
const prisma = new PrismaClient();

// ===== NOTIFICATION TYPES =====

export enum NotificationType {
  MENTION = 'mention',
  REPLY = 'reply',
  REACTION = 'reaction',
  POST_APPROVED = 'post_approved',
  POST_REJECTED = 'post_rejected',
  POST_CREATED = 'post_created',
  GROUP_INVITE = 'group_invite',
  GROUP_JOIN_REQUEST = 'group_join_request',
  MODERATION_ACTION = 'moderation_action',
  SYSTEM_ANNOUNCEMENT = 'system_announcement'
}

export interface NotificationPayload {
  type: NotificationType;
  title: string;
  message: string;
  data?: any;
  actionUrl?: string;
}

// ===== NOTIFICATION SERVICE =====

export class NotificationService {
  /**
   * Create a notification for a user
   */
  static async createNotification(
    userId: string,
    payload: NotificationPayload
  ): Promise<void> {
    try {
      await prisma.notification.create({
        data: {
          userId,
          type: payload.type,
          title: payload.title,
          message: payload.message,
          scheduledFor: new Date(),
          status: 'scheduled',
          metadata: {
            data: payload.data,
            actionUrl: payload.actionUrl
          }
        }
      });
    } catch (error) {
      console.error('Error creating notification:', error);
    }
  }

  /**
   * Create notifications for multiple users
   */
  static async createBulkNotifications(
    userIds: string[],
    payload: NotificationPayload
  ): Promise<void> {
    try {
      const notifications = userIds.map(userId => ({
        userId,
        type: payload.type,
        title: payload.title,
        message: payload.message,
        scheduledFor: new Date(),
        status: 'scheduled' as const,
        metadata: {
          data: payload.data,
          actionUrl: payload.actionUrl
        }
      }));

      await prisma.notification.createMany({
        data: notifications
      });
    } catch (error) {
      console.error('Error creating bulk notifications:', error);
    }
  }

  /**
   * Send mention notification
   */
  static async sendMentionNotification(
    mentionedUserId: string,
    mentionerId: string,
    targetType: 'post' | 'comment',
    targetId: string,
    content: string
  ): Promise<void> {
    const mentioner = await prisma.user.findUnique({
      where: { id: mentionerId },
      select: { name: true, handle: true }
    });

    if (!mentioner) return;

    const actionUrl = targetType === 'post' 
      ? `/posts/${targetId}`
      : `/posts/${targetId}#comment-${targetId}`;

    await this.createNotification(mentionedUserId, {
      type: NotificationType.MENTION,
      title: 'Du wurdest erwähnt',
      message: `${mentioner.name || mentioner.handle} hat dich in einem ${targetType === 'post' ? 'Post' : 'Kommentar'} erwähnt`,
      data: {
        mentionerId,
        targetType,
        targetId,
        content: content.substring(0, 100) + (content.length > 100 ? '...' : '')
      },
      actionUrl
    });
  }

  /**
   * Send reply notification
   */
  static async sendReplyNotification(
    originalAuthorId: string,
    replierId: string,
    postId: string,
    commentId: string,
    content: string
  ): Promise<void> {
    const replier = await prisma.user.findUnique({
      where: { id: replierId },
      select: { name: true, handle: true }
    });

    if (!replier || originalAuthorId === replierId) return;

    await this.createNotification(originalAuthorId, {
      type: NotificationType.REPLY,
      title: 'Neue Antwort',
      message: `${replier.name || replier.handle} hat auf deinen Post geantwortet`,
      data: {
        replierId,
        postId,
        commentId,
        content: content.substring(0, 100) + (content.length > 100 ? '...' : '')
      },
      actionUrl: `/posts/${postId}#comment-${commentId}`
    });
  }

  /**
   * Send reaction notification
   */
  static async sendReactionNotification(
    contentAuthorId: string,
    reactorId: string,
    targetType: 'post' | 'comment',
    targetId: string,
    reactionType: string
  ): Promise<void> {
    const reactor = await prisma.user.findUnique({
      where: { id: reactorId },
      select: { name: true, handle: true }
    });

    if (!reactor || contentAuthorId === reactorId) return;

    const actionUrl = targetType === 'post' 
      ? `/posts/${targetId}`
      : `/posts/${targetId}#comment-${targetId}`;

    await this.createNotification(contentAuthorId, {
      type: NotificationType.REACTION,
      title: 'Neue Reaktion',
      message: `${reactor.name || reactor.handle} hat deinen ${targetType === 'post' ? 'Post' : 'Kommentar'} mit ${reactionType} reagiert`,
      data: {
        reactorId,
        targetType,
        targetId,
        reactionType
      },
      actionUrl
    });
  }

  /**
   * Send post approval notification
   */
  static async sendPostApprovalNotification(
    authorId: string,
    postId: string,
    approved: boolean
  ): Promise<void> {
    const post = await prisma.post.findUnique({
      where: { id: postId },
      select: { title: true, group: { select: { name: true } } }
    });

    if (!post) return;

    await this.createNotification(authorId, {
      type: approved ? NotificationType.POST_APPROVED : NotificationType.POST_REJECTED,
      title: approved ? 'Post genehmigt' : 'Post abgelehnt',
      message: `Dein Post "${post.title || 'Ohne Titel'}" in ${post.group.name} wurde ${approved ? 'genehmigt' : 'abgelehnt'}`,
      data: {
        postId,
        groupName: post.group.name,
        approved
      },
      actionUrl: approved ? `/posts/${postId}` : undefined
    });
  }
}

// ===== API ENDPOINTS =====

// Get user notifications
router.get('/notifications', requireAuth, async (req, res, next) => {
  try {
    const userId = req.user?.id;
    const { page = 1, limit = 20, unreadOnly = false } = req.query;
    
    if (!userId) {
      return res.status(401).json({
        success: false,
        error: 'Authentication required'
      });
    }

    const skip = (Number(page) - 1) * Number(limit);

    // Build where clause
    const where: any = {
      userId
    };

    if (unreadOnly === 'true') {
      where.readAt = null;
    }

    // Get notifications from database
    const [notifications, total, unreadCount] = await Promise.all([
      prisma.notification.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: Number(limit)
      }),
      prisma.notification.count({ where }),
      prisma.notification.count({
        where: {
          userId,
          readAt: null
        }
      })
    ]);

    // Transform notifications to match expected format
    const transformedNotifications = notifications.map(notification => ({
      id: notification.id,
      type: notification.type,
      title: notification.title,
      message: notification.message,
      isRead: notification.readAt !== null,
      createdAt: notification.createdAt.toISOString(),
      data: (notification.metadata as any)?.data || {},
      actionUrl: (notification.metadata as any)?.actionUrl
    }));

    res.json({
      success: true,
      notifications: transformedNotifications,
      unreadCount,
      pagination: {
        page: Number(page),
        limit: Number(limit),
        total,
        pages: Math.ceil(total / Number(limit))
      }
    });
  } catch (error) {
    next(error);
  }
});

// Mark notification as read
router.post('/notifications/:id/read', requireAuth, async (req, res, next) => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    const { id } = req.params;

    const notification = await prisma.notification.findUnique({
      where: { id }
    });

    if (!notification) {
      return res.status(404).json({ error: 'Notification not found' });
    }

    if (notification.userId !== userId) {
      return res.status(403).json({ error: 'Not authorized' });
    }

    const updatedNotification = await prisma.notification.update({
      where: { id },
      data: { 
        readAt: new Date(),
        status: 'delivered'
      }
    });

    res.json({
      success: true,
      notification: updatedNotification
    });
  } catch (error) {
    next(error);
  }
});

// Mark all notifications as read
router.post('/notifications/read-all', requireAuth, async (req, res, next) => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    await prisma.notification.updateMany({
      where: { 
        userId,
        readAt: null
      },
      data: { 
        readAt: new Date(),
        status: 'delivered'
      }
    });

    res.json({
      success: true,
      message: 'All notifications marked as read'
    });
  } catch (error) {
    next(error);
  }
});

// Delete notification
router.delete('/notifications/:id', requireAuth, async (req, res, next) => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    const { id } = req.params;

    const notification = await prisma.notification.findUnique({
      where: { id }
    });

    if (!notification) {
      return res.status(404).json({ error: 'Notification not found' });
    }

    if (notification.userId !== userId) {
      return res.status(403).json({ error: 'Not authorized' });
    }

    await prisma.notification.delete({
      where: { id }
    });

    res.json({
      success: true,
      message: 'Notification deleted'
    });
  } catch (error) {
    next(error);
  }
});

// Get notification preferences
router.get('/notifications/preferences', requireAuth, async (req, res, next) => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { notificationSettings: true }
    });

    const defaultSettings = {
      mentions: { inApp: true, email: false, push: false },
      replies: { inApp: true, email: false, push: false },
      reactions: { inApp: true, email: false, push: false },
      postApprovals: { inApp: true, email: true, push: false },
      groupInvites: { inApp: true, email: true, push: false },
      moderationActions: { inApp: true, email: true, push: false },
      systemAnnouncements: { inApp: true, email: true, push: true },
      quietHours: { enabled: false, start: '22:00', end: '07:00' },
      digest: { enabled: true, frequency: 'weekly' } // daily, weekly, monthly
    };

    res.json({
      success: true,
      preferences: user?.notificationSettings || defaultSettings
    });
  } catch (error) {
    next(error);
  }
});

// Update notification preferences
router.put('/notifications/preferences', requireAuth, async (req, res, next) => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    const preferencesSchema = z.object({
      mentions: z.object({
        inApp: z.boolean(),
        email: z.boolean(),
        push: z.boolean()
      }),
      replies: z.object({
        inApp: z.boolean(),
        email: z.boolean(),
        push: z.boolean()
      }),
      reactions: z.object({
        inApp: z.boolean(),
        email: z.boolean(),
        push: z.boolean()
      }),
      postApprovals: z.object({
        inApp: z.boolean(),
        email: z.boolean(),
        push: z.boolean()
      }),
      groupInvites: z.object({
        inApp: z.boolean(),
        email: z.boolean(),
        push: z.boolean()
      }),
      moderationActions: z.object({
        inApp: z.boolean(),
        email: z.boolean(),
        push: z.boolean()
      }),
      systemAnnouncements: z.object({
        inApp: z.boolean(),
        email: z.boolean(),
        push: z.boolean()
      }),
      quietHours: z.object({
        enabled: z.boolean(),
        start: z.string(),
        end: z.string()
      }),
      digest: z.object({
        enabled: z.boolean(),
        frequency: z.enum(['daily', 'weekly', 'monthly'])
      })
    });

    const preferences = preferencesSchema.parse(req.body);

    await prisma.user.update({
      where: { id: userId },
      data: { notificationSettings: preferences }
    });

    res.json({
      success: true,
      preferences
    });
  } catch (error) {
    next(error);
  }
});

// ===== SUBSCRIPTIONS =====

// Subscribe to content
router.post('/subscriptions', requireAuth, async (req, res, next) => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    const { targetType, targetId, inApp = true, email = false, push = false } = req.body;

    const subscription = await prisma.subscription.upsert({
      where: {
        userId_targetType_targetId: {
          userId,
          targetType,
          targetId
        }
      },
      update: {
        inApp,
        email,
        push
      },
      create: {
        userId,
        targetType,
        targetId,
        inApp,
        email,
        push
      }
    });

    res.status(201).json({
      success: true,
      subscription
    });
  } catch (error) {
    next(error);
  }
});

// Unsubscribe from content
router.delete('/subscriptions/:targetType/:targetId', requireAuth, async (req, res, next) => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    const { targetType, targetId } = req.params;

    await prisma.subscription.delete({
      where: {
        userId_targetType_targetId: {
          userId,
          targetType,
          targetId
        }
      }
    });

    res.json({
      success: true,
      message: 'Unsubscribed successfully'
    });
  } catch (error) {
    next(error);
  }
});

// Get user subscriptions
router.get('/subscriptions', requireAuth, async (req, res, next) => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    const subscriptions = await prisma.subscription.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' }
    });

    res.json({
      success: true,
      subscriptions
    });
  } catch (error) {
    next(error);
  }
});

export { router as notificationRouter };
