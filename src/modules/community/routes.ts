import { Router } from 'express';
import { z } from 'zod';
import { PrismaClient } from '@prisma/client';
import { requireAuth } from '../../middleware/requireAuth';
import { AuthService, Permission } from '../../types/permissions';
import { NotificationService } from './notifications';

const router = Router();
const prisma = new PrismaClient();

// ===== GROUPS =====

// Create a new group
const createGroupSchema = z.object({
  name: z.string().min(1).max(100),
  slug: z.string().min(1).max(50).regex(/^[a-z0-9-]+$/),
  description: z.string().max(500).optional(),
  rules: z.string().max(2000).optional(),
  visibility: z.enum(['public', 'private', 'restricted']).default('public'),
  settings: z.object({
    postApprovalRequired: z.boolean().default(false),
    allowReactions: z.boolean().default(true),
    allowExternalEmbeds: z.boolean().default(true),
    defaultSorting: z.enum(['new', 'top', 'trending']).default('new')
  }).default({})
});

router.post('/groups', requireAuth, async (req, res, next) => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    const validatedData = createGroupSchema.parse(req.body);

    // Check if slug is already taken
    const existingGroup = await prisma.group.findUnique({
      where: { slug: validatedData.slug }
    });

    if (existingGroup) {
      return res.status(400).json({ error: 'Group slug already exists' });
    }

    const group = await prisma.group.create({
      data: {
        ...validatedData,
        ownerId: userId,
        members: {
          create: {
            userId: userId,
            role: 'owner',
            status: 'active'
          }
        }
      },
      include: {
        owner: {
          select: { id: true, name: true, handle: true, image: true }
        },
        members: {
          include: {
            user: {
              select: { id: true, name: true, handle: true, image: true }
            }
          }
        },
        _count: {
          select: { members: true, posts: true }
        }
      }
    });

    res.status(201).json({
      success: true,
      group
    });
  } catch (error) {
    next(error);
  }
});

// Get groups
router.get('/groups', async (req, res, next) => {
  try {
    const { page = 1, limit = 20, visibility = 'public' } = req.query;
    const skip = (Number(page) - 1) * Number(limit);

    const groups = await prisma.group.findMany({
      where: {
        isActive: true,
        visibility: visibility as string
      },
      include: {
        owner: {
          select: { id: true, name: true, handle: true, image: true }
        },
        _count: {
          select: { members: true, posts: true }
        }
      },
      orderBy: { createdAt: 'desc' },
      skip,
      take: Number(limit)
    });

    const total = await prisma.group.count({
      where: {
        isActive: true,
        visibility: visibility as string
      }
    });

    res.json({
      success: true,
      groups,
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

// Get single group
router.get('/groups/:slug', async (req, res, next) => {
  try {
    const { slug } = req.params;

    const group = await prisma.group.findUnique({
      where: { slug },
      include: {
        owner: {
          select: { id: true, name: true, handle: true, image: true }
        },
        members: {
          include: {
            user: {
              select: { id: true, name: true, handle: true, image: true }
            }
          },
          orderBy: { joinedAt: 'desc' },
          take: 10
        },
        _count: {
          select: { members: true, posts: true }
        }
      }
    });

    if (!group) {
      return res.status(404).json({ error: 'Group not found' });
    }

    res.json({
      success: true,
      group
    });
  } catch (error) {
    next(error);
  }
});

// Join group
router.post('/groups/:slug/join', requireAuth, async (req, res, next) => {
  try {
    const userId = req.user?.id;
    const { slug } = req.params;

    if (!userId) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    const group = await prisma.group.findUnique({
      where: { slug }
    });

    if (!group) {
      return res.status(404).json({ error: 'Group not found' });
    }

    // Check if user is already a member
    const existingMembership = await prisma.groupMember.findUnique({
      where: {
        groupId_userId: {
          groupId: group.id,
          userId: userId
        }
      }
    });

    if (existingMembership) {
      return res.status(400).json({ error: 'Already a member of this group' });
    }

    const membership = await prisma.groupMember.create({
      data: {
        groupId: group.id,
        userId: userId,
        role: 'member',
        status: group.visibility === 'public' ? 'active' : 'pending'
      },
      include: {
        user: {
          select: { id: true, name: true, handle: true, image: true }
        }
      }
    });

    // Send notification to group owner about new member
    try {
      if (group.ownerId !== userId) {
        await NotificationService.createNotification(group.ownerId, {
          type: 'group_join_request' as any,
          title: 'Neues Gruppenmitglied',
          message: `${membership.user.name} ist der Gruppe "${group.name}" beigetreten`,
          data: {
            groupId: group.id,
            memberId: userId,
            status: membership.status
          },
          actionUrl: `/groups/${group.slug}`
        });
      }
    } catch (error) {
      console.error('Error sending group join notification:', error);
      // Don't fail the join if notification fails
    }

    res.status(201).json({
      success: true,
      membership
    });
  } catch (error) {
    next(error);
  }
});

// ===== POSTS =====

// Create a new post
const createPostSchema = z.object({
  title: z.string().max(200).optional(),
  content: z.string().min(1).max(10000),
  groupId: z.string().optional(), // Optional group association
  media: z.array(z.object({
    type: z.enum(['image', 'video', 'file']),
    url: z.string(),
    filename: z.string(),
    size: z.number(),
    mimeType: z.string()
  })).optional(),
  ogPreview: z.object({
    title: z.string().optional(),
    description: z.string().optional(),
    image: z.string().optional(),
    url: z.string()
  }).optional(),
  scheduledFor: z.string().datetime().optional()
});

router.post('/posts', requireAuth, async (req, res, next) => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({
        success: false,
        error: 'Authentication required'
      });
    }

    const validatedData = createPostSchema.parse(req.body);

    if (!validatedData.content || !validatedData.content.trim()) {
      return res.status(400).json({
        success: false,
        error: 'Content is required'
      });
    }

    // If groupId is provided, verify the user is a member
    if (validatedData.groupId) {
      const membership = await prisma.groupMember.findUnique({
        where: {
          groupId_userId: {
            groupId: validatedData.groupId,
            userId: userId
          }
        }
      });

      if (!membership || membership.status !== 'active') {
        return res.status(403).json({
          success: false,
          error: 'Not a member of this group'
        });
      }
    }

    // Create the post in the database
    const newPost = await prisma.post.create({
      data: {
        title: validatedData.title?.trim() || null,
        content: validatedData.content.trim(),
        groupId: validatedData.groupId || null, // Use a default group or null for general posts
        authorId: userId,
        media: validatedData.media || null,
        ogPreview: validatedData.ogPreview || null,
        scheduledFor: validatedData.scheduledFor ? new Date(validatedData.scheduledFor) : null,
        status: validatedData.scheduledFor ? 'scheduled' : 'published',
        publishedAt: validatedData.scheduledFor ? null : new Date()
      },
      include: {
        author: {
          select: { id: true, name: true, handle: true, image: true }
        },
        group: {
          select: { id: true, name: true, slug: true }
        },
        _count: {
          select: { comments: true, reactions: true }
        }
      }
    });

    // Send notification to group members if this is a group post
    if (validatedData.groupId) {
      try {
        const groupMembers = await prisma.groupMember.findMany({
          where: {
            groupId: validatedData.groupId,
            status: 'active',
            userId: { not: userId } // Don't notify the author
          },
          select: { userId: true }
        });

        if (groupMembers.length > 0) {
          const memberIds = groupMembers.map(member => member.userId);
          await NotificationService.createBulkNotifications(memberIds, {
            type: 'post_created' as any,
            title: 'Neuer Post in der Gruppe',
            message: `Ein neuer Post wurde in der Gruppe erstellt`,
            data: {
              postId: newPost.id,
              groupId: validatedData.groupId,
              authorId: userId
            },
            actionUrl: `/posts/${newPost.id}`
          });
        }
      } catch (error) {
        console.error('Error sending group notifications:', error);
        // Don't fail the post creation if notifications fail
      }
    }

    res.status(201).json({
      success: true,
      post: {
        ...newPost,
        reactionCount: newPost._count.reactions,
        commentCount: newPost._count.comments,
        viewCount: newPost.viewCount
      },
      message: 'Post erfolgreich erstellt!'
    });
  } catch (error) {
    next(error);
  }
});

// Get posts with sorting
router.get('/posts', async (req, res, next) => {
  try {
    const { 
      sort = 'new', 
      page = 1, 
      limit = 20,
      cursor,
      search,
      groupId
    } = req.query;

    const skip = cursor ? 0 : (Number(page) - 1) * Number(limit);

    let orderBy: any = { createdAt: 'desc' };
    
    switch (sort) {
      case 'top':
        orderBy = { reactionCount: 'desc' };
        break;
      case 'trending':
        // Simplified trending algorithm
        orderBy = [
          { reactionCount: 'desc' },
          { createdAt: 'desc' }
        ];
        break;
      default:
        orderBy = { createdAt: 'desc' };
    }

    const where: any = {
      status: 'published'
    };

    if (cursor) {
      where.id = { lt: cursor };
    }

    if (groupId) {
      where.groupId = groupId;
    }

    if (search && typeof search === 'string') {
      where.OR = [
        { title: { contains: search, mode: 'insensitive' } },
        { content: { contains: search, mode: 'insensitive' } },
        { author: { name: { contains: search, mode: 'insensitive' } } }
      ];
    }

    const posts = await prisma.post.findMany({
      where,
      include: {
        author: {
          select: { id: true, name: true, handle: true, image: true }
        },
        group: {
          select: { id: true, name: true, slug: true }
        },
        _count: {
          select: { comments: true, reactions: true }
        }
      },
      orderBy,
      skip,
      take: Number(limit)
    });

    const total = await prisma.post.count({ where });

    res.json({
      success: true,
      posts: posts.map(post => ({
        ...post,
        reactionCount: post._count.reactions,
        commentCount: post._count.comments
      })),
      pagination: {
        page: Number(page),
        limit: Number(limit),
        total,
        pages: Math.ceil(total / Number(limit)),
        hasMore: skip + Number(limit) < total
      }
    });
  } catch (error) {
    next(error);
  }
});


// React to post (like/unlike)
router.post('/posts/:id/reactions', requireAuth, async (req, res, next) => {
  try {
    const { id } = req.params;
    const userId = req.user?.id;
    const { type = 'like' } = req.body;

    if (!userId) {
      return res.status(401).json({
        success: false,
        error: 'Authentication required'
      });
    }

    // Check if post exists
    const post = await prisma.post.findUnique({
      where: { id }
    });

    if (!post) {
      return res.status(404).json({
        success: false,
        error: 'Post not found'
      });
    }

    // Check if reaction already exists
    const existingReaction = await prisma.reaction.findUnique({
      where: {
        targetType_targetId_userId: {
          targetType: 'post',
          targetId: id,
          userId
        }
      }
    });

    if (existingReaction) {
      // Remove existing reaction
      await prisma.reaction.delete({
        where: { id: existingReaction.id }
      });

      // Update post reaction count
      await prisma.post.update({
        where: { id },
        data: { reactionCount: { decrement: 1 } }
      });

      return res.json({
        success: true,
        message: 'Like erfolgreich entfernt!',
        action: 'removed',
        reaction: null
      });
    }

    // Create new reaction
    const reaction = await prisma.reaction.create({
      data: {
        targetType: 'post',
        targetId: id,
        userId,
        type
      }
    });

    // Update post reaction count
    await prisma.post.update({
      where: { id },
      data: { reactionCount: { increment: 1 } }
    });

    // Send notification to post author
    try {
      const post = await prisma.post.findUnique({
        where: { id },
        select: { authorId: true }
      });

      if (post && post.authorId !== userId) {
        await NotificationService.sendReactionNotification(
          post.authorId,
          userId,
          'post',
          id,
          type
        );
      }
    } catch (error) {
      console.error('Error sending reaction notification:', error);
      // Don't fail the reaction if notification fails
    }

    res.json({
      success: true,
      message: 'Post erfolgreich geliked!',
      action: 'added',
      reaction
    });
  } catch (error) {
    next(error);
  }
});

// Remove reaction from post
router.delete('/posts/:id/reactions', requireAuth, async (req, res, next) => {
  try {
    const { id } = req.params;
    const userId = req.user?.id;

    if (!userId) {
      return res.status(401).json({
        success: false,
        error: 'Authentication required'
      });
    }

    // Find and remove the reaction
    const reaction = await prisma.reaction.findUnique({
      where: {
        targetType_targetId_userId: {
          targetType: 'post',
          targetId: id,
          userId
        }
      }
    });

    if (!reaction) {
      return res.status(404).json({
        success: false,
        error: 'Reaction not found'
      });
    }

    await prisma.reaction.delete({
      where: { id: reaction.id }
    });

    // Update post reaction count
    await prisma.post.update({
      where: { id },
      data: { reactionCount: { decrement: 1 } }
    });

    res.json({
      success: true,
      message: 'Like erfolgreich entfernt!'
    });
  } catch (error) {
    next(error);
  }
});

// Get comments for a post
router.get('/posts/:id/comments', async (req, res, next) => {
  try {
    const { id } = req.params;
    const { page = 1, limit = 20 } = req.query;
    const skip = (Number(page) - 1) * Number(limit);

    // Check if post exists
    const post = await prisma.post.findUnique({
      where: { id }
    });

    if (!post) {
      return res.status(404).json({
        success: false,
        error: 'Post not found'
      });
    }

    const comments = await prisma.comment.findMany({
      where: {
        postId: id,
        status: 'published',
        parentId: null // Only top-level comments
      },
      include: {
        author: {
          select: { id: true, name: true, handle: true, image: true }
        },
        replies: {
          include: {
            author: {
              select: { id: true, name: true, handle: true, image: true }
            },
            _count: {
              select: { reactions: true }
            }
          },
          orderBy: { createdAt: 'asc' }
        },
        _count: {
          select: { reactions: true }
        }
      },
      orderBy: { createdAt: 'asc' },
      skip,
      take: Number(limit)
    });

    const total = await prisma.comment.count({
      where: {
        postId: id,
        status: 'published',
        parentId: null
      }
    });

    res.json({
      success: true,
      comments: comments.map(comment => ({
        ...comment,
        reactionCount: comment._count.reactions,
        replies: comment.replies.map(reply => ({
          ...reply,
          reactionCount: reply._count.reactions
        }))
      })),
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

// Create comment for a post
router.post('/posts/:id/comments', requireAuth, async (req, res, next) => {
  try {
    const { id } = req.params;
    const { content, parentId } = req.body;
    const userId = req.user?.id;

    if (!content || !content.trim()) {
      return res.status(400).json({
        success: false,
        error: 'Content is required'
      });
    }

    if (!userId) {
      return res.status(401).json({
        success: false,
        error: 'Authentication required'
      });
    }

    // Check if post exists
    const post = await prisma.post.findUnique({
      where: { id }
    });

    if (!post) {
      return res.status(404).json({
        success: false,
        error: 'Post not found'
      });
    }

    // If parentId is provided, verify it's a valid comment
    if (parentId) {
      const parentComment = await prisma.comment.findUnique({
        where: { id: parentId }
      });

      if (!parentComment || parentComment.postId !== id) {
        return res.status(400).json({
          success: false,
          error: 'Invalid parent comment'
        });
      }
    }

    // Create the comment
    const newComment = await prisma.comment.create({
      data: {
        postId: id,
        authorId: userId,
        content: content.trim(),
        parentId: parentId || null
      },
      include: {
        author: {
          select: { id: true, name: true, handle: true, image: true }
        },
        _count: {
          select: { reactions: true }
        }
      }
    });

    // Update comment count on post
    await prisma.post.update({
      where: { id },
      data: { commentCount: { increment: 1 } }
    });

    // Send notification to post author
    try {
      const post = await prisma.post.findUnique({
        where: { id },
        select: { authorId: true }
      });

      if (post && post.authorId !== userId) {
        await NotificationService.sendReplyNotification(
          post.authorId,
          userId,
          id,
          newComment.id,
          content.trim()
        );
      }
    } catch (error) {
      console.error('Error sending reply notification:', error);
      // Don't fail the comment creation if notification fails
    }

    res.status(201).json({
      success: true,
      comment: {
        ...newComment,
        reactionCount: newComment._count.reactions
      },
      message: 'Kommentar erfolgreich erstellt!'
    });
  } catch (error) {
    next(error);
  }
});

// Get single post
router.get('/posts/:id', async (req, res, next) => {
  try {
    const { id } = req.params;

    const post = await prisma.post.findUnique({
      where: { id },
      include: {
        author: {
          select: { id: true, name: true, handle: true, image: true }
        },
        group: {
          select: { id: true, name: true, slug: true }
        },
        comments: {
          include: {
            author: {
              select: { id: true, name: true, handle: true, image: true }
            },
            _count: {
              select: { reactions: true }
            }
          },
          orderBy: { createdAt: 'asc' }
        },
        _count: {
          select: { comments: true, reactions: true }
        }
      }
    });

    if (!post) {
      return res.status(404).json({ error: 'Post not found' });
    }

    // Increment view count
    await prisma.post.update({
      where: { id },
      data: { viewCount: { increment: 1 } }
    });

    res.json({
      success: true,
      post
    });
  } catch (error) {
    next(error);
  }
});

// ===== COMMENTS =====

// Create a comment
const createCommentSchema = z.object({
  postId: z.string(),
  parentId: z.string().optional(),
  content: z.string().min(1).max(2000)
});

router.post('/comments', requireAuth, async (req, res, next) => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    const validatedData = createCommentSchema.parse(req.body);

    // Check if post exists
    const post = await prisma.post.findUnique({
      where: { id: validatedData.postId },
      include: { group: true }
    });

    if (!post) {
      return res.status(404).json({ error: 'Post not found' });
    }

    // Check if user is member of the group
    const membership = await prisma.groupMember.findUnique({
      where: {
        groupId_userId: {
          groupId: post.groupId,
          userId: userId
        }
      }
    });

    if (!membership || membership.status !== 'active') {
      return res.status(403).json({ error: 'Not a member of this group' });
    }

    const comment = await prisma.comment.create({
      data: {
        ...validatedData,
        authorId: userId
      },
      include: {
        author: {
          select: { id: true, name: true, handle: true, image: true }
        },
        _count: {
          select: { reactions: true }
        }
      }
    });

    // Update comment count on post
    await prisma.post.update({
      where: { id: validatedData.postId },
      data: { commentCount: { increment: 1 } }
    });

    res.status(201).json({
      success: true,
      comment
    });
  } catch (error) {
    next(error);
  }
});

// ===== REACTIONS =====

// Add reaction
router.post('/reactions', requireAuth, async (req, res, next) => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    const { targetType, targetId, type = 'like' } = req.body;

    // Check if reaction already exists
    const existingReaction = await prisma.reaction.findUnique({
      where: {
        targetType_targetId_userId: {
          targetType,
          targetId,
          userId
        }
      }
    });

    if (existingReaction) {
      // Toggle reaction
      await prisma.reaction.delete({
        where: { id: existingReaction.id }
      });

      // Update count
      if (targetType === 'post') {
        await prisma.post.update({
          where: { id: targetId },
          data: { reactionCount: { decrement: 1 } }
        });
      } else if (targetType === 'comment') {
        await prisma.comment.update({
          where: { id: targetId },
          data: { reactionCount: { decrement: 1 } }
        });
      }

      return res.json({
        success: true,
        action: 'removed',
        reaction: null
      });
    }

    // Create new reaction
    const reaction = await prisma.reaction.create({
      data: {
        targetType,
        targetId,
        userId,
        type
      }
    });

    // Update count
    if (targetType === 'post') {
      await prisma.post.update({
        where: { id: targetId },
        data: { reactionCount: { increment: 1 } }
      });
    } else if (targetType === 'comment') {
      await prisma.comment.update({
        where: { id: targetId },
        data: { reactionCount: { increment: 1 } }
      });
    }

    res.status(201).json({
      success: true,
      action: 'added',
      reaction
    });
  } catch (error) {
    next(error);
  }
});

// ===== SEARCH =====

router.get('/search', async (req, res, next) => {
  try {
    const { q, scope = 'posts', page = 1, limit = 20 } = req.query;

    if (!q || typeof q !== 'string') {
      return res.status(400).json({ error: 'Search query is required' });
    }

    const skip = (Number(page) - 1) * Number(limit);

    let results: any[] = [];

    switch (scope) {
      case 'posts':
        results = await prisma.post.findMany({
          where: {
            status: 'published',
            OR: [
              { title: { contains: q, mode: 'insensitive' } },
              { content: { contains: q, mode: 'insensitive' } }
            ]
          },
          include: {
            author: {
              select: { id: true, name: true, handle: true, image: true }
            },
            group: {
              select: { id: true, name: true, slug: true }
            }
          },
          orderBy: { createdAt: 'desc' },
          skip,
          take: Number(limit)
        });
        break;

      case 'users':
        results = await prisma.user.findMany({
          where: {
            OR: [
              { name: { contains: q, mode: 'insensitive' } },
              { handle: { contains: q, mode: 'insensitive' } }
            ]
          },
          select: {
            id: true,
            name: true,
            handle: true,
            image: true,
            bio: true
          },
          skip,
          take: Number(limit)
        });
        break;

      case 'groups':
        results = await prisma.group.findMany({
          where: {
            isActive: true,
            OR: [
              { name: { contains: q, mode: 'insensitive' } },
              { description: { contains: q, mode: 'insensitive' } }
            ]
          },
          include: {
            owner: {
              select: { id: true, name: true, handle: true, image: true }
            },
            _count: {
              select: { members: true, posts: true }
            }
          },
          skip,
          take: Number(limit)
        });
        break;
    }

    res.json({
      success: true,
      results,
      query: q,
      scope,
      pagination: {
        page: Number(page),
        limit: Number(limit)
      }
    });
  } catch (error) {
    next(error);
  }
});

export { router as communityRouter };
